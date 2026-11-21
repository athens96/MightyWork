"""마일스톤(릴리즈/에픽) CRUD 및 연결 일감 진척률 집계 API."""

from datetime import date

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, apply_patch, require
from app.models.common import utcnow
from app.models.member import Permission
from app.models.milestone import Milestone, MilestoneCreate, MilestoneRead, MilestoneUpdate
from app.models.task import PipelineStage, Task
from app.services.audit import record_audit
from app.services.events import publish_event

router = APIRouter(prefix="/projects/{project_id}/milestones", tags=["milestones"])

_STATUS_ORDER = {"active": 0, "planned": 1, "completed": 2}


def _build_read(m: Milestone, all_tasks: list[Task]) -> MilestoneRead:
    items = [t for t in all_tasks if t.milestone_id == m.id and t.triage_status is None]
    total = len(items)
    done = sum(1 for t in items if t.stage == PipelineStage.DONE)
    in_prog = sum(1 for t in items if t.stage in (PipelineStage.IN_PROGRESS, PipelineStage.REVIEW, PipelineStage.QA))
    total_pts = sum(t.estimate or 0 for t in items)
    done_pts = sum(t.estimate or 0 for t in items if t.stage == PipelineStage.DONE)
    pct = round((done / total) * 100) if total > 0 else 0
    return MilestoneRead(
        **m.model_dump(),
        total_tasks=total,
        done_tasks=done,
        in_progress_tasks=in_prog,
        total_points=total_pts,
        done_points=done_pts,
        progress_pct=pct,
    )


@router.get("", response_model=list[MilestoneRead])
def list_milestones(project: ProjectDep, db: DbDep) -> list[MilestoneRead]:
    items = db.milestones.list(lambda m: m.project_id == project.id)
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id)
    items.sort(key=lambda m: (_STATUS_ORDER[m.status], m.target_date is None, m.target_date or date.max, m.created_at))
    return [_build_read(m, all_tasks) for m in items]


@router.post("", response_model=MilestoneRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_milestone(project: ProjectDep, body: MilestoneCreate, user: CurrentUser, db: DbDep) -> MilestoneRead:
    m = db.milestones.create(Milestone(**body.model_dump(), project_id=project.id, created_by=user.id))
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="milestone.created",
        target_type="milestone",
        target_id=m.id,
        summary=f"마일스톤 '{m.name}' 생성",
    )
    publish_event(db, project.id, "milestone.updated", {"milestone_id": m.id})
    return _build_read(m, [])


@router.patch("/{milestone_id}", response_model=MilestoneRead, dependencies=[require(Permission.EDIT)])
def update_milestone(project: ProjectDep, milestone_id: str, body: MilestoneUpdate, db: DbDep) -> MilestoneRead:
    m = db.milestones.get(milestone_id)
    if m is None or m.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Milestone not found")
    updated = apply_patch(m, body)
    db.milestones.update(updated)
    publish_event(db, project.id, "milestone.updated", {"milestone_id": updated.id})
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id)
    return _build_read(updated, all_tasks)


@router.delete("/{milestone_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_milestone(project: ProjectDep, milestone_id: str, user: CurrentUser, db: DbDep) -> Response:
    m = db.milestones.get(milestone_id)
    if m is None or m.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Milestone not found")
    for t in db.tasks.list(lambda t: t.project_id == project.id and t.milestone_id == m.id):
        db.tasks.update(t.model_copy(update={"milestone_id": None, "updated_at": utcnow()}))
    db.milestones.delete(m.id)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="milestone.deleted",
        target_type="milestone",
        target_id=m.id,
        summary=f"마일스톤 '{m.name}' 삭제",
    )
    publish_event(db, project.id, "milestone.updated", {"milestone_id": m.id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
