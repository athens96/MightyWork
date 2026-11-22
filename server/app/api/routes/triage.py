"""트리아지 / 인테이크 대기열 API — 수락 · 중복 병합 · 보류(Snooze) · 거절 + 외부 접수 웹훅."""

import secrets
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, DbDep, ProjectDep, SettingsDep, require
from app.db import Database
from app.models.common import utcnow
from app.models.integration import ProjectIntake
from app.models.member import Permission
from app.models.task import PipelineStage, Priority, Task, TaskLink, TaskLinkKind, TaskRead
from app.services.audit import record_audit
from app.services.events import publish_event
from app.services.projects import allocate_task_number
from app.services.tasks import record_changes, record_created

router = APIRouter(tags=["triage"])


class TriageCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    priority: Priority = Priority.MEDIUM
    tags: list[str] = Field(default=[], max_length=20)
    source: str = Field(default="", max_length=120)


class TriageDecision(BaseModel):
    action: Literal["accept", "duplicate", "snooze", "decline"]
    target_stage: PipelineStage = PipelineStage.BACKLOG
    duplicate_of_id: str | None = None
    snooze_until: date | None = None


class IntakeConfigRead(BaseModel):
    enabled: bool
    token: str
    intake_url: str


class IntakeConfigUpdate(BaseModel):
    enabled: bool = True
    rotate_token: bool = False


class PublicIntakeSubmission(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)
    reporter_name: str = Field(default="", max_length=80)
    reporter_email: str = Field(default="", max_length=120)
    priority: Priority = Priority.MEDIUM
    tags: list[str] = Field(default=[], max_length=10)


def _to_read(db: Database, t: Task) -> TaskRead:
    cc = len(db.comments.list(lambda c: c.task_id == t.id))
    return TaskRead(**t.model_dump(), comment_count=cc, subtask_count=0, subtask_done=0)


def _find_intake(db: Database, project_id: str) -> ProjectIntake | None:
    found = db.project_intakes.list(lambda x: x.project_id == project_id)
    return found[0] if found else None


@router.get("/projects/{project_id}/triage", response_model=list[TaskRead])
def list_triage(project: ProjectDep, db: DbDep, include_declined: bool = False) -> list[TaskRead]:
    """트리아지 대기열 조회 (보류 기한이 지난 항목은 자동으로 pending 복귀)."""
    today = date.today()
    items: list[Task] = []
    for t in db.tasks.list(lambda x: x.project_id == project.id and x.deleted_at is None and x.triage_status is not None):
        if t.triage_status == "snoozed" and t.triage_snooze_until and t.triage_snooze_until <= today:
            t = t.model_copy(update={"triage_status": "pending", "triage_snooze_until": None, "updated_at": utcnow()})
            db.tasks.update(t)
        if t.triage_status == "declined" and not include_declined:
            continue
        items.append(t)
    order = {"pending": 0, "snoozed": 1, "declined": 2}
    items.sort(key=lambda t: (order.get(t.triage_status or "pending", 9), -t.created_at.timestamp()))
    return [_to_read(db, t) for t in items]


@router.post("/projects/{project_id}/triage", response_model=TaskRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_triage_item(project: ProjectDep, body: TriageCreate, user: CurrentUser, db: DbDep) -> TaskRead:
    number = allocate_task_number(db, project.id)
    task = db.tasks.create(
        Task(
            project_id=project.id,
            number=number,
            title=body.title.strip(),
            description=body.description,
            stage=PipelineStage.BACKLOG,
            priority=body.priority,
            tags=[t.strip() for t in body.tags if t.strip()],
            triage_status="pending",
            triage_source=body.source.strip() or (user.name or user.email),
            created_by=user.id,
        )
    )
    record_created(db, task, user.id)
    publish_event(db, project.id, "triage.updated", {"task_id": task.id})
    return _to_read(db, task)


@router.post("/projects/{project_id}/triage/{task_id}/decide", response_model=TaskRead, dependencies=[require(Permission.EDIT)])
def decide_triage_item(
    project: ProjectDep,
    task_id: str,
    body: TriageDecision,
    user: CurrentUser,
    db: DbDep,
) -> TaskRead:
    task = db.tasks.get(task_id)
    if task is None or task.project_id != project.id or task.triage_status is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Triage item not found")

    key = f"{project.key}-{task.number}"
    if body.action == "accept":
        updated = task.model_copy(
            update={
                "triage_status": None,
                "triage_snooze_until": None,
                "stage": body.target_stage,
                "updated_at": utcnow(),
            }
        )
        db.tasks.update(updated)
        record_changes(db, task, updated, user.id)
        record_audit(db, project_id=project.id, actor_id=user.id, action="triage.accepted", target_type="task", target_id=task.id, summary=f"{key} 트리아지 수락 → {body.target_stage.value}")
        publish_event(db, project.id, "task.created", {"task_id": updated.id, "stage": updated.stage.value})
        publish_event(db, project.id, "triage.updated", {"task_id": updated.id})
        return _to_read(db, updated)

    if body.action == "duplicate":
        if not body.duplicate_of_id or body.duplicate_of_id == task.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "duplicate_of_id is required")
        target = db.tasks.get(body.duplicate_of_id)
        if target is None or target.project_id != project.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Target task not found")
        existing = db.task_links.list(
            lambda l: l.project_id == project.id and l.source_id == task.id and l.target_id == target.id and l.kind == TaskLinkKind.DUPLICATES
        )
        if not existing:
            db.task_links.create(
                TaskLink(project_id=project.id, source_id=task.id, target_id=target.id, kind=TaskLinkKind.DUPLICATES, created_by=user.id)
            )
        updated = task.model_copy(update={"triage_status": "declined", "triage_snooze_until": None, "stage": PipelineStage.DONE, "updated_at": utcnow()})
        db.tasks.update(updated)
        record_audit(db, project_id=project.id, actor_id=user.id, action="triage.duplicated", target_type="task", target_id=task.id, summary=f"{key} 중복 병합 → {project.key}-{target.number}")
        publish_event(db, project.id, "triage.updated", {"task_id": updated.id})
        return _to_read(db, updated)

    if body.action == "snooze":
        until = body.snooze_until or (date.today() + timedelta(days=3))
        updated = task.model_copy(update={"triage_status": "snoozed", "triage_snooze_until": until, "updated_at": utcnow()})
        db.tasks.update(updated)
        publish_event(db, project.id, "triage.updated", {"task_id": updated.id})
        return _to_read(db, updated)

    # decline
    updated = task.model_copy(update={"triage_status": "declined", "triage_snooze_until": None, "updated_at": utcnow()})
    db.tasks.update(updated)
    record_audit(db, project_id=project.id, actor_id=user.id, action="triage.declined", target_type="task", target_id=task.id, summary=f"{key} 트리아지 거절")
    publish_event(db, project.id, "triage.updated", {"task_id": updated.id})
    return _to_read(db, updated)


@router.get("/projects/{project_id}/intake", response_model=IntakeConfigRead, dependencies=[require(Permission.ADMIN)])
def get_intake_config(project: ProjectDep, settings: SettingsDep, db: DbDep) -> IntakeConfigRead:
    cfg = _find_intake(db, project.id)
    if cfg is None:
        return IntakeConfigRead(enabled=False, token="", intake_url="")
    return IntakeConfigRead(
        enabled=cfg.enabled,
        token=cfg.token,
        intake_url=f"{settings.public_url.rstrip('/')}/api/intake/{cfg.token}",
    )


@router.put("/projects/{project_id}/intake", response_model=IntakeConfigRead, dependencies=[require(Permission.ADMIN)])
def update_intake_config(project: ProjectDep, body: IntakeConfigUpdate, settings: SettingsDep, db: DbDep) -> IntakeConfigRead:
    cfg = _find_intake(db, project.id)
    if cfg is None:
        cfg = db.project_intakes.create(
            ProjectIntake(project_id=project.id, token=secrets.token_urlsafe(20), enabled=body.enabled)
        )
    else:
        token = secrets.token_urlsafe(20) if body.rotate_token else cfg.token
        cfg = cfg.model_copy(update={"enabled": body.enabled, "token": token, "updated_at": utcnow()})
        db.project_intakes.update(cfg)
    return IntakeConfigRead(
        enabled=cfg.enabled,
        token=cfg.token,
        intake_url=f"{settings.public_url.rstrip('/')}/api/intake/{cfg.token}",
    )


@router.post("/intake/{token}", status_code=status.HTTP_201_CREATED)
def submit_public_intake(token: str, body: PublicIntakeSubmission, db: DbDep) -> dict[str, str]:
    """외부 버그 제보 폼·웹훅을 프로젝트 트리아지 대기열로 접수하는 선택형 공개 엔드포인트."""
    found = db.project_intakes.list(lambda x: x.enabled and secrets.compare_digest(x.token, token))
    if not found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid or disabled intake token")
    project = db.projects.get(found[0].project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

    source_parts = [p for p in (body.reporter_name.strip(), body.reporter_email.strip()) if p]
    source = " / ".join(source_parts) or "외부 제보"
    desc = body.description.strip()
    if source_parts:
        desc = f"> 제보자: {source}\n\n{desc}".strip()

    number = allocate_task_number(db, project.id)
    task = db.tasks.create(
        Task(
            project_id=project.id,
            number=number,
            title=body.title.strip(),
            description=desc,
            stage=PipelineStage.BACKLOG,
            priority=body.priority,
            tags=list(dict.fromkeys(["intake", *(t.strip() for t in body.tags if t.strip())])),
            triage_status="pending",
            triage_source=source,
            created_by=project.created_by,
        )
    )
    record_created(db, task, "intake")
    publish_event(db, project.id, "triage.updated", {"task_id": task.id})
    return {"key": f"{project.key}-{task.number}", "task_id": task.id, "status": "pending"}
