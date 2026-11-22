"""프로젝트 휴지통 (Soft Delete 보관·복구·영구 삭제·30일 경과 자동 정리)."""

from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, DbDep, ProjectDep, require
from app.db import Database
from app.models.common import utcnow
from app.models.member import Permission
from app.services.audit import record_audit
from app.services.events import publish_event
from app.services.tasks import delete_task_cascade, delete_wiki_page_cascade

router = APIRouter(prefix="/projects/{project_id}/trash", tags=["trash"])

TRASH_RETENTION_DAYS = 30
TrashKind = Literal["task", "wiki"]


class TrashItem(BaseModel):
    kind: TrashKind
    id: str
    title: str
    number: int | None = None
    deleted_at: datetime
    deleted_by: str | None = None
    days_left: int


def _purge_expired(db: Database, project_id: str) -> None:
    cutoff = utcnow() - timedelta(days=TRASH_RETENTION_DAYS)
    for t in db.tasks.list(lambda x: x.project_id == project_id and x.deleted_at is not None and x.deleted_at < cutoff):
        delete_task_cascade(db, t.id)
    for p in db.wiki_pages.list(lambda x: x.project_id == project_id and x.deleted_at is not None and x.deleted_at < cutoff):
        delete_wiki_page_cascade(db, p.id)


@router.get("", response_model=list[TrashItem])
def list_trash(project: ProjectDep, db: DbDep) -> list[TrashItem]:
    """휴지통 항목 조회 (30일 지난 항목은 자동 영구 삭제)."""
    _purge_expired(db, project.id)
    now = utcnow()
    items: list[TrashItem] = []

    for t in db.tasks.list(lambda x: x.project_id == project.id and x.deleted_at is not None):
        assert t.deleted_at is not None
        left = max(0, TRASH_RETENTION_DAYS - (now - t.deleted_at).days)
        items.append(TrashItem(kind="task", id=t.id, title=t.title, number=t.number, deleted_at=t.deleted_at, deleted_by=t.deleted_by, days_left=left))

    for p in db.wiki_pages.list(lambda x: x.project_id == project.id and x.deleted_at is not None):
        assert p.deleted_at is not None
        left = max(0, TRASH_RETENTION_DAYS - (now - p.deleted_at).days)
        items.append(TrashItem(kind="wiki", id=p.id, title=p.title, deleted_at=p.deleted_at, deleted_by=p.deleted_by, days_left=left))

    return sorted(items, key=lambda x: x.deleted_at, reverse=True)


@router.post("/{kind}/{item_id}/restore", status_code=status.HTTP_200_OK, dependencies=[require(Permission.EDIT)])
def restore_trash_item(project: ProjectDep, kind: TrashKind, item_id: str, user: CurrentUser, db: DbDep) -> dict[str, str]:
    """휴지통의 일감 또는 위키 문서를 복구한다."""
    if kind == "task":
        task = db.tasks.get(item_id)
        if task is None or task.project_id != project.id or task.deleted_at is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Trashed task not found")
        parent_id = task.parent_id
        if parent_id:
            parent = db.tasks.get(parent_id)
            if parent is None or parent.deleted_at is not None:
                parent_id = None
        restored = task.model_copy(update={"deleted_at": None, "deleted_by": None, "parent_id": parent_id, "updated_at": utcnow()})
        db.tasks.update(restored)
        key = f"{project.key}-{restored.number}"
        record_audit(db, project_id=project.id, actor_id=user.id, action="task.restored", target_type="task", target_id=restored.id, summary=f"{key} {restored.title} 휴지통에서 복구")
        publish_event(db, project.id, "task.created", {"task_id": restored.id, "stage": restored.stage.value})
        return {"kind": "task", "id": restored.id}

    page = db.wiki_pages.get(item_id)
    if page is None or page.project_id != project.id or page.deleted_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trashed page not found")
    parent_id = page.parent_id
    if parent_id:
        parent = db.wiki_pages.get(parent_id)
        if parent is None or parent.deleted_at is not None:
            parent_id = None
    restored_page = page.model_copy(update={"deleted_at": None, "deleted_by": None, "parent_id": parent_id, "updated_at": utcnow()})
    db.wiki_pages.update(restored_page)
    record_audit(db, project_id=project.id, actor_id=user.id, action="wiki.restored_from_trash", target_type="wiki", target_id=restored_page.id, summary=f"위키 '{restored_page.title}' 휴지통에서 복구")
    publish_event(db, project.id, "wiki.updated", {"page_id": restored_page.id})
    return {"kind": "wiki", "id": restored_page.id}


@router.delete("/{kind}/{item_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def purge_trash_item(project: ProjectDep, kind: TrashKind, item_id: str, user: CurrentUser, db: DbDep) -> Response:
    """휴지통 항목을 영구 삭제한다."""
    if kind == "task":
        task = db.tasks.get(item_id)
        if task is None or task.project_id != project.id or task.deleted_at is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Trashed task not found")
        key = f"{project.key}-{task.number}"
        delete_task_cascade(db, task.id)
        record_audit(db, project_id=project.id, actor_id=user.id, action="task.purged", target_type="task", target_id=task.id, summary=f"{key} {task.title} 영구 삭제")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    page = db.wiki_pages.get(item_id)
    if page is None or page.project_id != project.id or page.deleted_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trashed page not found")
    delete_wiki_page_cascade(db, page.id)
    record_audit(db, project_id=project.id, actor_id=user.id, action="wiki.purged", target_type="wiki", target_id=page.id, summary=f"위키 '{page.title}' 영구 삭제")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/empty", status_code=status.HTTP_200_OK, dependencies=[require(Permission.ADMIN)])
def empty_trash(project: ProjectDep, user: CurrentUser, db: DbDep) -> dict[str, int]:
    """프로젝트 휴지통을 모두 비운다 (관리자 전용)."""
    purged = 0
    for t in db.tasks.list(lambda x: x.project_id == project.id and x.deleted_at is not None):
        delete_task_cascade(db, t.id)
        purged += 1
    for p in db.wiki_pages.list(lambda x: x.project_id == project.id and x.deleted_at is not None):
        delete_wiki_page_cascade(db, p.id)
        purged += 1
    if purged:
        record_audit(db, project_id=project.id, actor_id=user.id, action="trash.emptied", target_type="project", target_id=project.id, summary=f"휴지통 비우기 ({purged}건 영구 삭제)")
    return {"purged": purged}
