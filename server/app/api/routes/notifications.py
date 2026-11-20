"""사용자 알림 API (@멘션, 작업자 배정, 덧글, 소유권 이전, 초대)."""

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, DbDep
from app.models.common import utcnow
from app.models.notification import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationList(BaseModel):
    unread_count: int
    items: list[Notification]


@router.get("", response_model=NotificationList)
def list_notifications(
    user: CurrentUser,
    db: DbDep,
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=200),
) -> NotificationList:
    mine = db.notifications.list(lambda n: n.user_id == user.id)
    unread_count = sum(1 for n in mine if not n.read)
    filtered = [n for n in mine if not unread_only or not n.read]
    ordered = sorted(filtered, key=lambda n: n.created_at, reverse=True)[:limit]
    return NotificationList(unread_count=unread_count, items=ordered)


@router.post("/{notification_id}/read", response_model=Notification)
def mark_read(notification_id: str, user: CurrentUser, db: DbDep) -> Notification:
    n = db.notifications.get(notification_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found")
    if not n.read:
        n = n.model_copy(update={"read": True, "updated_at": utcnow()})
        db.notifications.update(n)
    return n


@router.post("/read-all")
def mark_all_read(user: CurrentUser, db: DbDep) -> dict[str, int]:
    now = utcnow()
    updated = 0
    for n in db.notifications.list(lambda n: n.user_id == user.id and not n.read):
        db.notifications.update(n.model_copy(update={"read": True, "updated_at": now}))
        updated += 1
    return {"updated": updated}
