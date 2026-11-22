"""버전별 릴리즈 집계 및 Keep-a-Changelog 형식 Markdown 자동 생성 서비스."""

from datetime import date, datetime
import re
from typing import Literal

from pydantic import BaseModel

from app.models.project import Project
from app.models.task import PIPELINE_LABELS, PipelineStage, Priority, Task

ReleaseStatus = Literal["released", "in_progress", "planned"]

_VER_RE = re.compile(r"^v?(\d+)\.(\d+|x|\*)(?:\.(\d+|x|\*))?", re.IGNORECASE)
_BUG_KEYWORDS = ("bug", "fix", "hotfix", "error", "버그", "수정", "오류", "장애")
_UX_KEYWORDS = ("ux", "ui", "dx", "perf", "performance", "responsive", "mobile", "pwa", "organization", "refactor", "개선")
_INFRA_KEYWORDS = ("infra", "deploy", "ci", "ci-cd", "github", "github-actions", "webhook", "migration", "versioning", "security", "config", "docs", "testing", "e2e", "release")


class ReleaseTaskItem(BaseModel):
    id: str
    number: int
    key: str
    title: str
    stage: PipelineStage
    priority: Priority
    tags: list[str] = []
    estimate: int | None = None
    assignee_id: str | None = None
    updated_at: datetime


class ReleaseSummary(BaseModel):
    version: str
    status: ReleaseStatus
    total_tasks: int
    done_tasks: int
    in_progress_tasks: int
    todo_tasks: int
    total_points: int
    done_points: int
    progress_pct: int
    latest_updated_at: datetime | None = None
    tasks: list[ReleaseTaskItem] = []


class ReleaseListResponse(BaseModel):
    releases: list[ReleaseSummary]
    unversioned_count: int = 0


class ReleaseChangelogResponse(BaseModel):
    version: str
    markdown: str
    total_tasks: int
    done_tasks: int
    included_tasks: int


def version_sort_key(version: str) -> tuple[int, int, int, int, int, str]:
    """최신 버전이 앞에 오도록 내림차순 정렬 키 반환 (v0.7.0 > v0.6.x > v0.6.0 > v0.5.10 > v0.5.9)."""
    cleaned = version.strip().split("-")[0]
    m = _VER_RE.match(cleaned)
    if not m:
        return (1, 0, 0, 0, 0, version.casefold())
    major = int(m.group(1))
    minor_raw = m.group(2)
    patch_raw = m.group(3)
    minor = int(minor_raw) if minor_raw.isdigit() else 10**9
    patch = -1 if patch_raw is None else (int(patch_raw) if patch_raw.isdigit() else 10**9)
    is_wild = 1 if ("x" in cleaned.lower() or "*" in cleaned) else 0
    return (0, -major, -minor, -patch, -is_wild, version.casefold())


def build_releases(project: Project, all_tasks: list[Task]) -> ReleaseListResponse:
    """프로젝트 일감들을 version 필드로 묶어 릴리즈 진행 현황을 집계한다."""
    active_tasks = [t for t in all_tasks if t.triage_status is None]
    buckets: dict[str, list[Task]] = {}
    unversioned = 0

    for t in active_tasks:
        if not t.version:
            unversioned += 1
            continue
        buckets.setdefault(t.version, []).append(t)

    releases: list[ReleaseSummary] = []
    for ver in sorted(buckets.keys(), key=version_sort_key):
        items = sorted(buckets[ver], key=lambda t: t.number)
        total = len(items)
        done = sum(1 for t in items if t.stage == PipelineStage.DONE)
        in_prog = sum(1 for t in items if t.stage in (PipelineStage.IN_PROGRESS, PipelineStage.REVIEW, PipelineStage.QA))
        todo = total - done - in_prog
        total_pts = sum(t.estimate or 0 for t in items)
        done_pts = sum(t.estimate or 0 for t in items if t.stage == PipelineStage.DONE)
        pct = round((done / total) * 100) if total > 0 else 0
        if total > 0 and done == total:
            status: ReleaseStatus = "released"
        elif done > 0 or in_prog > 0:
            status = "in_progress"
        else:
            status = "planned"

        latest = max((t.updated_at for t in items), default=None)
        releases.append(
            ReleaseSummary(
                version=ver,
                status=status,
                total_tasks=total,
                done_tasks=done,
                in_progress_tasks=in_prog,
                todo_tasks=todo,
                total_points=total_pts,
                done_points=done_pts,
                progress_pct=pct,
                latest_updated_at=latest,
                tasks=[
                    ReleaseTaskItem(
                        id=t.id,
                        number=t.number,
                        key=f"{project.key}-{t.number}",
                        title=t.title,
                        stage=t.stage,
                        priority=t.priority,
                        tags=t.tags,
                        estimate=t.estimate,
                        assignee_id=t.assignee_id,
                        updated_at=t.updated_at,
                    )
                    for t in items
                ],
            )
        )

    return ReleaseListResponse(releases=releases, unversioned_count=unversioned)


def _classify_task(task: Task) -> str:
    tags_cf = {tag.casefold() for tag in task.tags}
    title_cf = task.title.casefold()
    if any(k in tags_cf for k in _BUG_KEYWORDS) or any(k in title_cf for k in ("버그", "오류", "fix:", "bug:")):
        return "bug"
    if any(k in tags_cf for k in _UX_KEYWORDS):
        return "ux"
    if any(k in tags_cf for k in _INFRA_KEYWORDS):
        return "infra"
    return "feat"


def build_changelog(
    project: Project,
    all_tasks: list[Task],
    version: str,
    *,
    include_unfinished: bool = False,
    release_date: date | None = None,
) -> ReleaseChangelogResponse | None:
    """특정 버전 일감들로 Markdown 체인지로그(릴리즈 노트)를 생성한다."""
    ver_cf = version.strip().casefold()
    matched = sorted(
        [t for t in all_tasks if t.triage_status is None and t.version and t.version.casefold() == ver_cf],
        key=lambda t: t.number,
    )
    if not matched:
        return None

    canonical_version = matched[0].version or version.strip()
    done_items = [t for t in matched if t.stage == PipelineStage.DONE]
    unfinished = [t for t in matched if t.stage != PipelineStage.DONE]
    total = len(matched)
    done_count = len(done_items)
    pct = round((done_count / total) * 100) if total else 0
    day = (release_date or date.today()).isoformat()

    lines: list[str] = [
        f"## {project.name} {canonical_version} ({day})",
        "",
        f"> 총 {total}건 중 {done_count}건 완료 ({pct}%)",
        "",
    ]

    sections: list[tuple[str, str]] = [
        ("feat", "### ✨ 주요 기능"),
        ("ux", "### ⚡ UX · 성능 개선"),
        ("bug", "### 🐛 버그 수정"),
        ("infra", "### 🔧 인프라 · 연동 · 설정"),
    ]
    grouped: dict[str, list[Task]] = {k: [] for k, _ in sections}
    for t in done_items:
        grouped[_classify_task(t)].append(t)

    if done_items:
        for key, heading in sections:
            bucket = grouped[key]
            if not bucket:
                continue
            lines.append(heading)
            for t in bucket:
                lines.append(f"- **{project.key}-{t.number}** {t.title}")
            lines.append("")
    else:
        lines.append("_아직 완료된 일감이 없습니다._")
        lines.append("")

    included = done_count
    if include_unfinished and unfinished:
        lines.append("### 🚧 진행 중 · 예정")
        for t in unfinished:
            stage_label = PIPELINE_LABELS.get(t.stage, t.stage.value)
            lines.append(f"- [ ] **{project.key}-{t.number}** {t.title} ({stage_label})")
        lines.append("")
        included += len(unfinished)

    markdown = "\n".join(lines).rstrip() + "\n"
    return ReleaseChangelogResponse(
        version=canonical_version,
        markdown=markdown,
        total_tasks=total,
        done_tasks=done_count,
        included_tasks=included,
    )
