from fastapi import APIRouter

from app.api.deps import CurrentUser, DbDep
from app.models.user import User

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[User])
def list_users(_: CurrentUser, db: DbDep) -> list[User]:
    """담당자 지정 등에 사용."""
    return sorted(db.users.list(), key=lambda u: u.name or u.email)
