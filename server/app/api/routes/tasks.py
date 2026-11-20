from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, TaskDep, apply_patch, require
from app.db import Database
from app.models.member import Permission
from app.models.project import Project
from app.models.task import (
    PIPELINE_LABELS,
    PipelineStage,
    PipelineStageInfo,
    Task,
    TaskCreate,
    TaskRead,
    TaskUpdate,
)
from app.services.access import is_member_user
from app.services.projects import allocate_task_number
from app.services.tasks import delete_task_cascade, record_changes, record_created

pipeline_router = APIRouter(tags=["tasks"])
router = APIRouter(prefix="/projects/{project_id}/tasks", tags=["tasks"])


@pipeline_router.get("/pipeline", response_model=list[PipelineStageInfo])
def get_pipeline(_: CurrentUser) -> list[PipelineStageInfo]:
    """보드 컬럼 구성(파이프라인 단계). 모든 프로젝트 공통."""
    return [PipelineStageInfo(key=s, label=PIPELINE_LABELS[s]) for s in PipelineStage]


def _ensure_assignee_is_member(db: Database, project: Project, assignee_id: str | None) -> None:
    if assignee_id is not None and not is_member_user(db, project, assignee_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be a project member")


def _read(db: Database, task: Task, comment_count: int | None = None) -> TaskRead:
    if comment_count is None:
        comment_count = len(db.comments.list(lambda c: c.task_id == task.id))
    return TaskRead(**task.model_dump(), comment_count=comment_count)


@router.get("", response_model=list[TaskRead])
def list_tasks(
    project: ProjectDep,
    db: DbDep,
    stage: PipelineStage | None = None,
    assignee_id: str | None = None,
) -> list[TaskRead]:
    tasks = db.tasks.list(
        lambda t: t.project_id == project.id
        and (stage is None or t.stage == stage)
        and (assignee_id is None or t.assignee_id == assignee_id)
    )
    counts: dict[str, int] = {}
    for c in db.comments.list(lambda c: c.project_id == project.id):
        counts[c.task_id] = counts.get(c.task_id, 0) + 1
    return [_read(db, t, counts.get(t.id, 0)) for t in sorted(tasks, key=lambda t: t.number)]


@router.post("", response_model=TaskRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_task(project: ProjectDep, body: TaskCreate, user: CurrentUser, db: DbDep) -> TaskRead:
    _ensure_assignee_is_member(db, project, body.assignee_id)
    number = allocate_task_number(db, project.id)
    task = db.tasks.create(Task(**body.model_dump(), project_id=project.id, number=number, created_by=user.id))
    record_created(db, task, user.id)
    return _read(db, task, 0)


@router.get("/{task_id}", response_model=TaskRead)
def get_task(task: TaskDep, db: DbDep) -> TaskRead:
    return _read(db, task)


@router.patch("/{task_id}", response_model=TaskRead, dependencies=[require(Permission.EDIT)])
def update_task(project: ProjectDep, task: TaskDep, body: TaskUpdate, user: CurrentUser, db: DbDep) -> TaskRead:
    if "assignee_id" in body.model_fields_set:
        _ensure_assignee_is_member(db, project, body.assignee_id)
    updated = apply_patch(task, body)
    db.tasks.update(updated)
    record_changes(db, task, updated, user.id)
    return _read(db, updated)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_task(task: TaskDep, db: DbDep) -> Response:
    delete_task_cascade(db, task.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
