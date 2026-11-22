"""사이클(스프린트) CRUD · 번다운 계산 · 미완료 자동 이월 API."""

from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, apply_patch, require
from app.db import Database
from app.models.common import utcnow
from app.models.cycle import (
    Cycle,
    CycleBurndownPoint,
    CycleCompleteRequest,
    CycleCompleteResult,
    CycleCreate,
    CycleRead,
    CycleUpdate,
)
from app.models.member import Permission
from app.models.task import PipelineStage, Task
from app.services.audit import record_audit
from app.services.events import publish_event
from app.services.tasks import record_changes

router = APIRouter(prefix="/projects/{project_id}/cycles", tags=["cycles"])

_STATUS_ORDER = {"active": 0, "upcoming": 1, "completed": 2}


def _done_dates(db: Database, task_ids: set[str]) -> dict[str, date]:
    """완료된 일감들이 'done' 단계로 이동한 날짜를 변경 이력에서 계산."""
    done_at: dict[str, date] = {}
    if not task_ids:
        return done_at
    for act in db.task_activities.list(lambda a: a.task_id in task_ids and a.field == "stage" and a.new == PipelineStage.DONE.value):
        d = act.created_at.date()
        prev = done_at.get(act.task_id)
        if prev is None or d > prev:
            done_at[act.task_id] = d
    return done_at


def _build_read(db: Database, cycle: Cycle, all_tasks: list[Task]) -> CycleRead:
    items = [t for t in all_tasks if t.cycle_id == cycle.id]
    total_tasks = len(items)
    done_items = [t for t in items if t.stage == PipelineStage.DONE]
    done_tasks = len(done_items)
    total_points = sum(t.estimate or 0 for t in items)
    done_points = sum(t.estimate or 0 for t in done_items)

    # 번다운 기준 단위: 추정치 합계가 있으면 pt, 없으면 일감 개수
    use_points = total_points > 0
    scope = float(total_points if use_points else total_tasks)
    completion_pct = round((done_points / total_points) * 100) if total_points > 0 else (round((done_tasks / total_tasks) * 100) if total_tasks > 0 else 0)

    span = max(0, (cycle.end_date - cycle.start_date).days)
    step = 1 if span <= 21 else max(1, span // 14)
    days: list[date] = []
    cur = cycle.start_date
    while cur < cycle.end_date:
        days.append(cur)
        cur += timedelta(days=step)
    days.append(cycle.end_date)

    done_map = _done_dates(db, {t.id for t in done_items})
    today = date.today()
    burndown: list[CycleBurndownPoint] = []
    n_slots = max(1, len(days) - 1)
    for idx, d in enumerate(days):
        ideal = round(scope * (1.0 - idx / n_slots), 1) if len(days) > 1 else 0.0
        if d > today and cycle.status != "completed":
            remaining = None
        else:
            burned = 0.0
            for t in done_items:
                finished_on = done_map.get(t.id, t.updated_at.date())
                if finished_on <= d:
                    burned += float(t.estimate or 0) if use_points else 1.0
            remaining = round(max(0.0, scope - burned), 1)
        burndown.append(CycleBurndownPoint(day=d.isoformat(), ideal=ideal, remaining=remaining))

    return CycleRead(
        **cycle.model_dump(),
        total_tasks=total_tasks,
        done_tasks=done_tasks,
        total_points=total_points,
        done_points=done_points,
        completion_pct=completion_pct,
        burndown=burndown,
    )


def _get_cycle(db: Database, project_id: str, cycle_id: str) -> Cycle:
    cycle = db.cycles.get(cycle_id)
    if cycle is None or cycle.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cycle not found")
    return cycle


@router.get("", response_model=list[CycleRead])
def list_cycles(project: ProjectDep, db: DbDep) -> list[CycleRead]:
    cycles = db.cycles.list(lambda c: c.project_id == project.id)
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id and t.deleted_at is None)
    cycles.sort(key=lambda c: (_STATUS_ORDER[c.status], c.start_date if c.status != "completed" else date.max - (c.end_date - date.min)))
    return [_build_read(db, c, all_tasks) for c in cycles]


@router.post("", response_model=CycleRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_cycle(project: ProjectDep, body: CycleCreate, user: CurrentUser, db: DbDep) -> CycleRead:
    cycle = db.cycles.create(Cycle(**body.model_dump(), project_id=project.id, created_by=user.id))
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="cycle.created",
        target_type="cycle",
        target_id=cycle.id,
        summary=f"사이클 '{cycle.name}' 생성 ({cycle.start_date} ~ {cycle.end_date})",
    )
    publish_event(db, project.id, "cycle.updated", {"cycle_id": cycle.id})
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id and t.deleted_at is None)
    return _build_read(db, cycle, all_tasks)


@router.patch("/{cycle_id}", response_model=CycleRead, dependencies=[require(Permission.EDIT)])
def update_cycle(project: ProjectDep, cycle_id: str, body: CycleUpdate, db: DbDep) -> CycleRead:
    cycle = _get_cycle(db, project.id, cycle_id)
    updated = apply_patch(cycle, body)
    db.cycles.update(updated)
    publish_event(db, project.id, "cycle.updated", {"cycle_id": updated.id})
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id and t.deleted_at is None)
    return _build_read(db, updated, all_tasks)


@router.delete("/{cycle_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_cycle(project: ProjectDep, cycle_id: str, user: CurrentUser, db: DbDep) -> Response:
    cycle = _get_cycle(db, project.id, cycle_id)
    for t in db.tasks.list(lambda t: t.project_id == project.id and t.cycle_id == cycle.id):
        db.tasks.update(t.model_copy(update={"cycle_id": None, "updated_at": utcnow()}))
    db.cycles.delete(cycle.id)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="cycle.deleted",
        target_type="cycle",
        target_id=cycle.id,
        summary=f"사이클 '{cycle.name}' 삭제",
    )
    publish_event(db, project.id, "cycle.updated", {"cycle_id": cycle.id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{cycle_id}/complete", response_model=CycleCompleteResult, dependencies=[require(Permission.EDIT)])
def complete_cycle(project: ProjectDep, cycle_id: str, body: CycleCompleteRequest, user: CurrentUser, db: DbDep) -> CycleCompleteResult:
    """사이클을 완료 처리하고, 미완료 일감을 다음 사이클로 자동 이월한다."""
    cycle = _get_cycle(db, project.id, cycle_id)
    completed = cycle.model_copy(update={"status": "completed", "updated_at": utcnow()})
    db.cycles.update(completed)

    incomplete = db.tasks.list(
        lambda t: t.project_id == project.id and t.deleted_at is None and t.cycle_id == cycle.id and t.stage != PipelineStage.DONE
    )
    next_cycle: Cycle | None = None
    rolled = 0

    if body.rollover and (incomplete or body.next_cycle_id):
        if body.next_cycle_id:
            next_cycle = _get_cycle(db, project.id, body.next_cycle_id)
            if next_cycle.id == cycle.id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot roll over into the same cycle")
        else:
            upcoming = sorted(
                db.cycles.list(lambda c: c.project_id == project.id and c.id != cycle.id and c.status == "upcoming"),
                key=lambda c: c.start_date,
            )
            if upcoming:
                next_cycle = upcoming[0]
            else:
                duration = max(1, (cycle.end_date - cycle.start_date).days)
                next_start = cycle.end_date + timedelta(days=1)
                next_end = next_start + timedelta(days=duration)
                seq = len(db.cycles.list(lambda c: c.project_id == project.id)) + 1
                next_cycle = db.cycles.create(
                    Cycle(
                        project_id=project.id,
                        name=f"Cycle {seq}",
                        goal="",
                        start_date=next_start,
                        end_date=next_end,
                        target_points=cycle.target_points,
                        status="active",
                        created_by=user.id,
                    )
                )

        if next_cycle.status == "upcoming":
            next_cycle = next_cycle.model_copy(update={"status": "active", "updated_at": utcnow()})
            db.cycles.update(next_cycle)

        for t in incomplete:
            moved = t.model_copy(update={"cycle_id": next_cycle.id, "updated_at": utcnow()})
            db.tasks.update(moved)
            record_changes(db, t, moved, user.id)
            publish_event(db, project.id, "task.updated", {"task_id": moved.id, "stage": moved.stage.value})
            rolled += 1

    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="cycle.completed",
        target_type="cycle",
        target_id=cycle.id,
        summary=f"사이클 '{cycle.name}' 완료 (미완료 {rolled}건 이월)",
    )
    publish_event(db, project.id, "cycle.updated", {"cycle_id": cycle.id})
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id and t.deleted_at is None)
    return CycleCompleteResult(
        completed=_build_read(db, completed, all_tasks),
        next_cycle=_build_read(db, next_cycle, all_tasks) if next_cycle else None,
        rolled_over_count=rolled,
    )
