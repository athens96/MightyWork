from fastapi import APIRouter

from app.api.deps import CurrentUser, DbDep, ProjectDep
from app.models.user import User
from app.services.access import project_related_users, visible_users_for

router = APIRouter(tags=["users"])


@router.get("/users", response_model=list[User])
def list_users(user: CurrentUser, db: DbDep) -> list[User]:
    """내가 속한 프로젝트와 연관된 사용자만 반환 (다른 프로젝트 사용자 비노출)."""
    return visible_users_for(db, user)


@router.get("/projects/{project_id}/users", response_model=list[User])
def list_project_users(project: ProjectDep, db: DbDep) -> list[User]:
    """특정 프로젝트의 멤버 및 일감·덧글·위키 이력에 등장하는 사용자 목록."""
    return project_related_users(db, project)
