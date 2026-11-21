from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.api.deps import AccessDep, CurrentUser, DbDep, ProjectDep, SettingsDep, TaskDep, apply_patch, require
from app.db import Database
from app.models.common import utcnow
from app.models.member import Permission
from app.models.project import Project
from app.models.task import (
    PIPELINE_LABELS,
    PipelineStage,
    PipelineStageInfo,
    Priority,
    ProjectPipeline,
    ProjectPipelineUpdate,
    Task,
    TaskCreate,
    TaskLink,
    TaskLinkCreate,
    TaskLinkKind,
    TaskLinkRead,
    TaskRead,
    TaskUpdate,
    default_pipeline_stages,
)
from app.services.access import accessible_projects, is_member_user
from app.services.audit import record_audit
from app.services.events import publish_event
from app.services.links import link_targets, norm_title, pages_by_title, project_pages
from app.services.notifications import notify_mentions, notify_user
from app.services.projects import allocate_task_number
from app.services.tasks import delete_task_cascade, record_changes, record_created
from app.services.webhooks import dispatch_project_webhooks

pipeline_router = APIRouter(tags=["tasks"])
router = APIRouter(prefix="/projects/{project_id}/tasks", tags=["tasks"])

_REVERSE_KIND = {
    TaskLinkKind.BLOCKS: "blocked_by",
    TaskLinkKind.RELATES_TO: "relates_to",
    TaskLinkKind.DUPLICATES: "duplicated_by",
}


class MyTaskRead(TaskRead):
    project_key: str
    project_name: str


class TaskBulkRequest(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=200)
    stage: PipelineStage | None = None
    priority: Priority | None = None
    assignee_id: str | None = None
    cycle_id: str | None = None
    milestone_id: str | None = None
    add_tags: list[str] | None = None
    remove_tags: list[str] | None = None
    delete: bool = False


class TaskBulkResult(BaseModel):
    affected: int
    tasks: list[TaskRead] = []


_PRIO_ORDER = {Priority.URGENT: 0, Priority.HIGH: 1, Priority.MEDIUM: 2, Priority.LOW: 3}


@pipeline_router.get("/pipeline", response_model=list[PipelineStageInfo])
def get_pipeline(_: CurrentUser) -> list[PipelineStageInfo]:
    """보드 컬럼 구성(파이프라인 단계 기본 프리셋)."""
    return default_pipeline_stages()


def _project_pipeline_stages(db: Database, project_id: str) -> list[PipelineStageInfo]:
    found = db.project_pipelines.list(lambda p: p.project_id == project_id)
    if not found:
        return default_pipeline_stages()
    stages = list(found[0].stages)
    present = {s.key for s in stages}
    for s in PipelineStage:
        if s not in present:
            stages.append(PipelineStageInfo(key=s, label=PIPELINE_LABELS[s], hidden=True))
    return stages


@pipeline_router.get("/projects/{project_id}/pipeline", response_model=list[PipelineStageInfo])
def get_project_pipeline(project: ProjectDep, db: DbDep) -> list[PipelineStageInfo]:
    """프로젝트별 커스텀 파이프라인(이름·색상·순서·숨김·WIP 상한) 조회."""
    return _project_pipeline_stages(db, project.id)


@pipeline_router.put(
    "/projects/{project_id}/pipeline",
    response_model=list[PipelineStageInfo],
    dependencies=[require(Permission.ADMIN)],
)
def update_project_pipeline(
    project: ProjectDep,
    body: ProjectPipelineUpdate,
    user: CurrentUser,
    db: DbDep,
) -> list[PipelineStageInfo]:
    """관리자용 파이프라인 설정 저장 + 숨김 단계의 기존 일감 안전 매핑."""
    seen: set[PipelineStage] = set()
    normalized: list[PipelineStageInfo] = []
    for st in body.stages:
        if st.key in seen:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate stage: {st.key.value}")
        seen.add(st.key)
        normalized.append(st.model_copy(update={"label": st.label.strip() or PIPELINE_LABELS[st.key]}))
    for s in PipelineStage:
        if s not in seen:
            normalized.append(PipelineStageInfo(key=s, label=PIPELINE_LABELS[s], hidden=True))

    visible = [st.key for st in normalized if not st.hidden]
    if not visible:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one pipeline stage must remain visible")

    hidden_keys = {st.key for st in normalized if st.hidden}
    fallback = body.remap_hidden_to if (body.remap_hidden_to and body.remap_hidden_to in visible) else visible[0]
    remapped = 0
    if hidden_keys:
        for t in db.tasks.list(lambda x: x.project_id == project.id and x.stage in hidden_keys):
            moved = t.model_copy(update={"stage": fallback, "updated_at": utcnow()})
            db.tasks.update(moved)
            record_changes(db, t, moved, user.id)
            publish_event(db, project.id, "task.updated", {"task_id": moved.id, "stage": moved.stage.value})
            remapped += 1

    existing = db.project_pipelines.list(lambda p: p.project_id == project.id)
    if existing:
        db.project_pipelines.update(existing[0].model_copy(update={"stages": normalized, "updated_at": utcnow()}))
    else:
        db.project_pipelines.create(ProjectPipeline(project_id=project.id, stages=normalized))

    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="project.pipeline_updated",
        target_type="project",
        target_id=project.id,
        summary=f"파이프라인 설정 변경 (표시 {len(visible)}단계, 일감 매핑 {remapped}건)",
    )
    publish_event(db, project.id, "pipeline.updated", {"project_id": project.id})
    return normalized


@pipeline_router.get("/my/tasks", response_model=list[MyTaskRead])
def list_my_tasks(
    user: CurrentUser,
    db: DbDep,
    scope: Literal["assigned", "created", "all"] = "assigned",
    due_soon: bool = False,
    include_done: bool = False,
    stage: PipelineStage | None = None,
) -> list[MyTaskRead]:
    """내가 속한 모든 프로젝트에서 내 일감을 한 번에 조회한다 (Linear My Issues 스타일)."""
    projects_by_id = {a.project.id: a.project for a in accessible_projects(db, user)}
    if not projects_by_id:
        return []
    cutoff = date.today() + timedelta(days=2)
    all_tasks = db.tasks.list(lambda t: t.project_id in projects_by_id and t.triage_status is None)
    sub_counts: dict[str, list[int]] = {}
    for t in all_tasks:
        if t.parent_id:
            pair = sub_counts.setdefault(t.parent_id, [0, 0])
            pair[0] += 1
            if t.stage == PipelineStage.DONE:
                pair[1] += 1
    comment_counts: dict[str, int] = {}
    for c in db.comments.list(lambda c: c.project_id in projects_by_id):
        comment_counts[c.task_id] = comment_counts.get(c.task_id, 0) + 1

    picked: list[MyTaskRead] = []
    for t in all_tasks:
        if scope == "assigned" and t.assignee_id != user.id:
            continue
        if scope == "created" and t.created_by != user.id:
            continue
        if scope == "all" and t.assignee_id != user.id and t.created_by != user.id:
            continue
        if stage is not None and t.stage != stage:
            continue
        if not include_done and stage != PipelineStage.DONE and t.stage == PipelineStage.DONE:
            continue
        if due_soon and (t.due_date is None or t.due_date > cutoff or t.stage == PipelineStage.DONE):
            continue
        p = projects_by_id[t.project_id]
        base = _read(db, t, comment_counts.get(t.id, 0), tuple(sub_counts.get(t.id, (0, 0))))
        picked.append(MyTaskRead(**base.model_dump(), project_key=p.key, project_name=p.name))

    return sorted(
        picked,
        key=lambda t: (
            t.stage == PipelineStage.DONE,
            t.due_date is None,
            t.due_date or date.max,
            _PRIO_ORDER[t.priority],
            -t.updated_at.timestamp(),
        ),
    )


def _ensure_assignee_is_member(db: Database, project: Project, assignee_id: str | None) -> None:
    if assignee_id is not None and not is_member_user(db, project, assignee_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be a project member")


def _validate_cycle(db: Database, project: Project, cycle_id: str | None) -> None:
    if cycle_id is None:
        return
    cycle = db.cycles.get(cycle_id)
    if cycle is None or cycle.project_id != project.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cycle not found")


def _validate_milestone(db: Database, project: Project, milestone_id: str | None) -> None:
    if milestone_id is None:
        return
    m = db.milestones.get(milestone_id)
    if m is None or m.project_id != project.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Milestone not found")


def _validate_parent(db: Database, project: Project, task_id: str | None, parent_id: str | None) -> None:
    """상위 일감이 같은 프로젝트에 존재하는지, 순환이 생기지 않는지 확인."""
    current = parent_id
    while current is not None:
        if current == task_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Task cannot be nested under itself")
        parent = db.tasks.get(current)
        if parent is None or parent.project_id != project.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Parent task not found")
        current = parent.parent_id


def _read(
    db: Database,
    task: Task,
    comment_count: int | None = None,
    subtask_stats: tuple[int, int] | None = None,
) -> TaskRead:
    if comment_count is None:
        comment_count = len(db.comments.list(lambda c: c.task_id == task.id))
    if subtask_stats is None:
        subs = db.tasks.list(lambda t: t.parent_id == task.id)
        subtask_stats = (len(subs), sum(1 for s in subs if s.stage == PipelineStage.DONE))
    return TaskRead(**task.model_dump(), comment_count=comment_count, subtask_count=subtask_stats[0], subtask_done=subtask_stats[1])


@router.get("", response_model=list[TaskRead])
def list_tasks(
    project: ProjectDep,
    db: DbDep,
    stage: PipelineStage | None = None,
    assignee_id: str | None = None,
    parent_id: str | None = None,
    cycle_id: str | None = None,
    milestone_id: str | None = None,
    include_triage: bool = False,
) -> list[TaskRead]:
    all_project_tasks = db.tasks.list(
        lambda t: t.project_id == project.id and (include_triage or t.triage_status is None)
    )
    sub_counts: dict[str, list[int]] = {}
    for t in all_project_tasks:
        if t.parent_id:
            pair = sub_counts.setdefault(t.parent_id, [0, 0])
            pair[0] += 1
            if t.stage == PipelineStage.DONE:
                pair[1] += 1
    tasks = [
        t
        for t in all_project_tasks
        if (stage is None or t.stage == stage)
        and (assignee_id is None or t.assignee_id == assignee_id)
        and (parent_id is None or t.parent_id == parent_id)
        and (cycle_id is None or t.cycle_id == cycle_id)
        and (milestone_id is None or t.milestone_id == milestone_id)
    ]
    counts: dict[str, int] = {}
    for c in db.comments.list(lambda c: c.project_id == project.id):
        counts[c.task_id] = counts.get(c.task_id, 0) + 1
    return [
        _read(db, t, counts.get(t.id, 0), tuple(sub_counts.get(t.id, (0, 0))))
        for t in sorted(tasks, key=lambda t: t.number)
    ]


@router.post("", response_model=TaskRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_task(project: ProjectDep, body: TaskCreate, user: CurrentUser, settings: SettingsDep, db: DbDep) -> TaskRead:
    _ensure_assignee_is_member(db, project, body.assignee_id)
    _validate_parent(db, project, None, body.parent_id)
    _validate_cycle(db, project, body.cycle_id)
    _validate_milestone(db, project, body.milestone_id)
    number = allocate_task_number(db, project.id)
    task = db.tasks.create(Task(**body.model_dump(), project_id=project.id, number=number, created_by=user.id))
    record_created(db, task, user.id)
    link = f"/projects/{project.id}/tasks/{task.id}"
    key = f"{project.key}-{task.number}"
    if task.assignee_id:
        notify_user(
            db,
            user_id=task.assignee_id,
            project_id=project.id,
            actor_id=user.id,
            kind="assigned",
            title=f"{key} '{task.title}' 일감이 배정되었습니다",
            link=link,
        )
    notify_mentions(
        db,
        project=project,
        actor=user,
        text=task.description,
        title=f"{key} '{task.title}' 설명에서 나를 언급했습니다",
        link=link,
    )
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="task.created",
        target_type="task",
        target_id=task.id,
        summary=f"{key} {task.title} 생성",
    )
    publish_event(db, project.id, "task.created", {"task_id": task.id, "stage": task.stage.value})
    dispatch_project_webhooks(
        db,
        project,
        event="task.created",
        title=f"새 일감 {key}: {task.title}",
        body=f"작성자: {user.name or user.email} · 단계: {PIPELINE_LABELS[task.stage]}",
        link=f"{settings.app_url.rstrip('/')}{link}",
        extra={"task_id": task.id, "key": key, "stage": task.stage.value, "tags": task.tags},
    )
    return _read(db, task, 0, (0, 0))


@router.post("/bulk", response_model=TaskBulkResult)
def bulk_update_tasks(
    access: AccessDep,
    project: ProjectDep,
    body: TaskBulkRequest,
    user: CurrentUser,
    db: DbDep,
) -> TaskBulkResult:
    """여러 일감의 단계·우선순위·작업자·사이클·레이블을 일괄 수정하거나 일괄 삭제한다."""
    need = Permission.DELETE if body.delete else Permission.EDIT
    if not access.can(need):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing permission: {need.value}")
    if "assignee_id" in body.model_fields_set:
        _ensure_assignee_is_member(db, project, body.assignee_id)
    if "cycle_id" in body.model_fields_set:
        _validate_cycle(db, project, body.cycle_id)
    if "milestone_id" in body.model_fields_set:
        _validate_milestone(db, project, body.milestone_id)

    seen: set[str] = set()
    updated_reads: list[TaskRead] = []
    affected = 0

    for tid in body.task_ids:
        if tid in seen:
            continue
        seen.add(tid)
        task = db.tasks.get(tid)
        if task is None or task.project_id != project.id:
            continue

        if body.delete:
            delete_task_cascade(db, task.id)
            publish_event(db, project.id, "task.deleted", {"task_id": task.id})
            affected += 1
            continue

        patch_data: dict[str, object] = {}
        if body.stage is not None:
            patch_data["stage"] = body.stage
        if body.priority is not None:
            patch_data["priority"] = body.priority
        if "assignee_id" in body.model_fields_set:
            patch_data["assignee_id"] = body.assignee_id
        if "cycle_id" in body.model_fields_set:
            patch_data["cycle_id"] = body.cycle_id
        if "milestone_id" in body.model_fields_set:
            patch_data["milestone_id"] = body.milestone_id
        if body.add_tags or body.remove_tags:
            tags = list(task.tags)
            if body.remove_tags:
                rm = {t.strip() for t in body.remove_tags if t.strip()}
                tags = [t for t in tags if t not in rm]
            if body.add_tags:
                for t in body.add_tags:
                    clean = t.strip()
                    if clean and clean not in tags:
                        tags.append(clean)
            patch_data["tags"] = tags

        if not patch_data:
            continue
        patch_data["updated_at"] = utcnow()
        updated = task.model_copy(update=patch_data)
        db.tasks.update(updated)
        record_changes(db, task, updated, user.id)
        publish_event(db, project.id, "task.updated", {"task_id": updated.id, "stage": updated.stage.value})
        updated_reads.append(_read(db, updated))
        affected += 1

    if affected:
        record_audit(
            db,
            project_id=project.id,
            actor_id=user.id,
            action="task.bulk_deleted" if body.delete else "task.bulk_updated",
            target_type="project",
            target_id=project.id,
            summary=f"일감 {affected}건 일괄 {'삭제' if body.delete else '편집'}",
        )
    return TaskBulkResult(affected=affected, tasks=updated_reads)


@router.get("/{task_id}", response_model=TaskRead)
def get_task(task: TaskDep, db: DbDep) -> TaskRead:
    return _read(db, task)


@router.patch("/{task_id}", response_model=TaskRead, dependencies=[require(Permission.EDIT)])
def update_task(project: ProjectDep, task: TaskDep, body: TaskUpdate, user: CurrentUser, settings: SettingsDep, db: DbDep) -> TaskRead:
    if "assignee_id" in body.model_fields_set:
        _ensure_assignee_is_member(db, project, body.assignee_id)
    if "parent_id" in body.model_fields_set:
        _validate_parent(db, project, task.id, body.parent_id)
    if "cycle_id" in body.model_fields_set:
        _validate_cycle(db, project, body.cycle_id)
    if "milestone_id" in body.model_fields_set:
        _validate_milestone(db, project, body.milestone_id)
    updated = apply_patch(task, body)
    db.tasks.update(updated)
    record_changes(db, task, updated, user.id)
    link = f"/projects/{project.id}/tasks/{updated.id}"
    key = f"{project.key}-{updated.number}"
    if updated.assignee_id and updated.assignee_id != task.assignee_id:
        notify_user(
            db,
            user_id=updated.assignee_id,
            project_id=project.id,
            actor_id=user.id,
            kind="assigned",
            title=f"{key} '{updated.title}' 일감이 배정되었습니다",
            link=link,
        )
    if updated.description != task.description:
        notify_mentions(
            db,
            project=project,
            actor=user,
            text=updated.description,
            title=f"{key} '{updated.title}' 설명에서 나를 언급했습니다",
            link=link,
        )
    publish_event(db, project.id, "task.updated", {"task_id": updated.id, "stage": updated.stage.value})
    if updated.stage != task.stage:
        dispatch_project_webhooks(
            db,
            project,
            event="task.stage_changed",
            title=f"{key} '{updated.title}' 단계 이동: {PIPELINE_LABELS[task.stage]} → {PIPELINE_LABELS[updated.stage]}",
            body=f"변경자: {user.name or user.email}",
            link=f"{settings.app_url.rstrip('/')}{link}",
            extra={"task_id": updated.id, "key": key, "from": task.stage.value, "stage": updated.stage.value, "tags": updated.tags},
        )
    return _read(db, updated)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_task(project: ProjectDep, task: TaskDep, user: CurrentUser, db: DbDep) -> Response:
    key = f"{project.key}-{task.number}"
    delete_task_cascade(db, task.id)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="task.deleted",
        target_type="task",
        target_id=task.id,
        summary=f"{key} {task.title} 삭제",
    )
    publish_event(db, project.id, "task.deleted", {"task_id": task.id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- 하위 일감 · 일감 간 링크 · 위키 링크


@router.get("/{task_id}/subtasks", response_model=list[TaskRead])
def list_subtasks(task: TaskDep, db: DbDep) -> list[TaskRead]:
    subs = sorted(db.tasks.list(lambda t: t.parent_id == task.id), key=lambda t: t.number)
    return [_read(db, s) for s in subs]


@router.get("/{task_id}/links", response_model=list[TaskLinkRead])
def list_task_links(task: TaskDep, db: DbDep) -> list[TaskLinkRead]:
    links = db.task_links.list(lambda l: l.source_id == task.id or l.target_id == task.id)
    out: list[TaskLinkRead] = []
    for l in sorted(links, key=lambda x: x.created_at):
        is_src = l.source_id == task.id
        other_id = l.target_id if is_src else l.source_id
        other = db.tasks.get(other_id)
        if other is None:
            continue
        kind = l.kind.value if is_src else _REVERSE_KIND[l.kind]
        out.append(TaskLinkRead(id=l.id, kind=kind, task_id=other.id, number=other.number, title=other.title, stage=other.stage))
    return out


@router.post("/{task_id}/links", response_model=TaskLinkRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.EDIT)])
def create_task_link(project: ProjectDep, task: TaskDep, body: TaskLinkCreate, user: CurrentUser, db: DbDep) -> TaskLinkRead:
    if body.target_id == task.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot link a task to itself")
    target = db.tasks.get(body.target_id)
    if target is None or target.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Target task not found")
    # 중복 검사 (relates_to 는 양방향 동일 취급)
    for l in db.task_links.list(lambda x: x.project_id == project.id):
        same_dir = l.source_id == task.id and l.target_id == target.id and l.kind == body.kind
        sym_dup = body.kind == TaskLinkKind.RELATES_TO and l.kind == TaskLinkKind.RELATES_TO and l.source_id == target.id and l.target_id == task.id
        if same_dir or sym_dup:
            raise HTTPException(status.HTTP_409_CONFLICT, "Task link already exists")
    created = db.task_links.create(
        TaskLink(project_id=project.id, source_id=task.id, target_id=target.id, kind=body.kind, created_by=user.id)
    )
    return TaskLinkRead(id=created.id, kind=created.kind.value, task_id=target.id, number=target.number, title=target.title, stage=target.stage)


@router.delete("/{task_id}/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.EDIT)])
def delete_task_link(project: ProjectDep, task: TaskDep, link_id: str, db: DbDep) -> Response:
    link = db.task_links.get(link_id)
    if link is None or link.project_id != project.id or task.id not in (link.source_id, link.target_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task link not found")
    db.task_links.delete(link.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{task_id}/wiki-links")
def task_outgoing_wiki_links(project: ProjectDep, task: TaskDep, db: DbDep) -> list[dict[str, str | None]]:
    """일감 설명에서 [[링크]] 로 가리킨 위키 문서들 (양방향 일감↔위키 연결)."""
    by_title = pages_by_title(project_pages(db, project))
    return [
        {"title": title, "page_id": (p.id if (p := by_title.get(norm_title(title))) else None)}
        for title in link_targets(task.description)
    ]
