"""GitHub 연동 API: 프로젝트별 저장소·시크릿 설정, 일감 PR/커밋 조회, Webhook 수신 및 자동 단계 전환."""

import hashlib
import hmac
import re
import secrets

from fastapi import APIRouter, HTTPException, Request, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, SettingsDep, TaskDep, require
from app.models.common import utcnow
from app.models.integration import GitHubIntegration, GitHubIntegrationRead, GitHubIntegrationUpdate, GitHubLink
from app.models.member import Permission
from app.models.task import PipelineStage
from app.services.audit import record_audit
from app.services.tasks import record_changes

router = APIRouter(tags=["github"])


def _find_config(db, project_id: str) -> GitHubIntegration | None:
    found = db.github_integrations.list(lambda g: g.project_id == project_id)
    return found[0] if found else None


def _extract_task_numbers(text: str, project_key: str) -> list[int]:
    """대소문자 무관하게 'MW-12' / 'mw-12' 형식의 일감 번호 추출."""
    pattern = re.compile(rf"(?<![A-Za-z0-9]){re.escape(project_key)}-(\d+)(?![A-Za-z0-9])", re.IGNORECASE)
    seen, out = set(), []
    for m in pattern.finditer(text):
        n = int(m.group(1))
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _verify_signature(secret: str, body: bytes, signature: str) -> bool:
    if not secret or not signature.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


@router.get("/projects/{project_id}/github", response_model=GitHubIntegrationRead)
def get_github_config(project: ProjectDep, settings: SettingsDep, db: DbDep) -> GitHubIntegrationRead:
    cfg = _find_config(db, project.id)
    return GitHubIntegrationRead(
        repo=cfg.repo if cfg else "",
        has_secret=bool(cfg and cfg.webhook_secret),
        auto_transition=cfg.auto_transition if cfg else True,
        webhook_url=f"{settings.public_url.rstrip('/')}/api/webhooks/github",
    )


@router.put("/projects/{project_id}/github", response_model=GitHubIntegrationRead, dependencies=[require(Permission.ADMIN)])
def update_github_config(
    project: ProjectDep,
    body: GitHubIntegrationUpdate,
    user: CurrentUser,
    settings: SettingsDep,
    db: DbDep,
) -> GitHubIntegrationRead:
    repo = body.repo.strip().strip("/")
    cfg = _find_config(db, project.id)
    generated: str | None = None
    if body.rotate_secret:
        secret = secrets.token_hex(24)
        generated = secret
    elif body.webhook_secret is not None:
        secret = body.webhook_secret.strip()
    elif cfg is not None:
        secret = cfg.webhook_secret
    else:
        secret = secrets.token_hex(24)
        generated = secret

    if cfg is None:
        cfg = db.github_integrations.create(
            GitHubIntegration(project_id=project.id, repo=repo, webhook_secret=secret, auto_transition=body.auto_transition)
        )
    else:
        cfg = cfg.model_copy(update={"repo": repo, "webhook_secret": secret, "auto_transition": body.auto_transition, "updated_at": utcnow()})
        db.github_integrations.update(cfg)

    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="project.github_updated",
        target_type="project",
        target_id=project.id,
        summary=f"GitHub 연동 설정 변경: {repo or '(해제)'}",
    )
    return GitHubIntegrationRead(
        repo=cfg.repo,
        has_secret=bool(cfg.webhook_secret),
        auto_transition=cfg.auto_transition,
        webhook_url=f"{settings.public_url.rstrip('/')}/api/webhooks/github",
        generated_secret=generated,
    )


@router.get("/projects/{project_id}/tasks/{task_id}/github", response_model=list[GitHubLink])
def list_task_github_links(task: TaskDep, db: DbDep) -> list[GitHubLink]:
    return sorted(db.github_links.list(lambda l: l.task_id == task.id), key=lambda l: l.updated_at, reverse=True)


def _upsert_link(db, *, project_id: str, task_id: str, kind: str, ref: str, title: str, url: str, state: str, author: str, branch: str) -> None:
    existing = db.github_links.list(lambda l: l.task_id == task_id and l.kind == kind and l.ref == ref)
    if existing:
        updated = existing[0].model_copy(update={"title": title, "url": url, "state": state, "author": author, "branch": branch, "updated_at": utcnow()})
        db.github_links.update(updated)
    else:
        db.github_links.create(
            GitHubLink(project_id=project_id, task_id=task_id, kind=kind, ref=ref, title=title[:200], url=url, state=state, author=author, branch=branch)
        )


def _transition(db, task, next_stage: PipelineStage) -> None:
    if task.stage == next_stage:
        return
    updated = task.model_copy(update={"stage": next_stage, "updated_at": utcnow()})
    db.tasks.update(updated)
    record_changes(db, task, updated, "github")


@router.post("/webhooks/github")
async def github_webhook(request: Request, db: DbDep) -> dict:
    raw = await request.body()
    event = request.headers.get("x-github-event", "")
    sig = request.headers.get("x-hub-signature-256", "")
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid JSON payload")

    repo_name = (payload.get("repository") or {}).get("full_name", "").strip()
    if not repo_name:
        return {"ok": True, "matched": 0}

    configs = [g for g in db.github_integrations.list() if g.repo.casefold() == repo_name.casefold()]
    if not configs:
        return {"ok": True, "matched": 0}

    matched_tasks = 0
    for cfg in configs:
        if not _verify_signature(cfg.webhook_secret, raw, sig):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid GitHub webhook signature")
        project = db.projects.get(cfg.project_id)
        if project is None:
            continue
        by_num = {t.number: t for t in db.tasks.list(lambda t: t.project_id == project.id)}

        if event == "pull_request":
            pr = payload.get("pull_request") or {}
            action = payload.get("action", "")
            pr_num = pr.get("number")
            title = pr.get("title", "")
            body_text = pr.get("body") or ""
            branch = (pr.get("head") or {}).get("ref", "")
            url = pr.get("html_url", "")
            author = (pr.get("user") or {}).get("login", "")
            merged = bool(pr.get("merged"))
            state = "merged" if merged else pr.get("state", "open")

            nums = _extract_task_numbers(f"{branch}\n{title}\n{body_text}", project.key)
            for n in nums:
                task = by_num.get(n)
                if task is None:
                    continue
                _upsert_link(db, project_id=project.id, task_id=task.id, kind="pr", ref=f"#{pr_num}", title=title, url=url, state=state, author=author, branch=branch)
                if cfg.auto_transition:
                    if action == "closed" and merged:
                        _transition(db, task, PipelineStage.DONE)
                    elif action in ("opened", "reopened", "ready_for_review") and task.stage in (PipelineStage.BACKLOG, PipelineStage.TODO, PipelineStage.IN_PROGRESS):
                        _transition(db, task, PipelineStage.REVIEW)
                matched_tasks += 1

        elif event == "push":
            branch = str(payload.get("ref", "")).removeprefix("refs/heads/")
            branch_nums = _extract_task_numbers(branch, project.key)
            for commit in payload.get("commits") or []:
                sha = str(commit.get("id", ""))[:7]
                msg = str(commit.get("message", "")).splitlines()[0] if commit.get("message") else ""
                url = str(commit.get("url", ""))
                author = (commit.get("author") or {}).get("username") or (commit.get("author") or {}).get("name") or ""
                nums = list(dict.fromkeys([*branch_nums, *_extract_task_numbers(str(commit.get("message", "")), project.key)]))
                for n in nums:
                    task = by_num.get(n)
                    if task is None:
                        continue
                    _upsert_link(db, project_id=project.id, task_id=task.id, kind="commit", ref=sha, title=msg, url=url, state="pushed", author=author, branch=branch)
                    if cfg.auto_transition and task.stage in (PipelineStage.BACKLOG, PipelineStage.TODO):
                        _transition(db, task, PipelineStage.IN_PROGRESS)
                    matched_tasks += 1

    return {"ok": True, "matched": matched_tasks}
