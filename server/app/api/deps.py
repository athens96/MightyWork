from typing import Annotated, TypeVar

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ValidationError

from app.core.config import Settings
from app.core.security import decode_access_token
from app.db import Database
from app.models.common import Entity, utcnow
from app.models.member import Permission
from app.models.project import Project
from app.models.task import Task
from app.models.user import User
from app.services.access import Access, resolve_access
from app.services.google_auth import GoogleVerifier, verify_google_credential

_bearer = HTTPBearer(auto_error=False)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_google_verifier() -> GoogleVerifier:
    """테스트에서 dependency_overrides 로 교체할 수 있도록 분리."""
    return verify_google_credential


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    db: Annotated[Database, Depends(get_db)],
) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        raise unauthorized
    try:
        user_id = decode_access_token(credentials.credentials, settings)
    except jwt.PyJWTError:
        raise unauthorized
    user = db.users.get(user_id)
    if user is None:
        raise unauthorized
    return user


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[Database, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def get_access(project_id: str, user: CurrentUser, db: DbDep) -> Access:
    """경로의 {project_id} 에 대한 현재 사용자 권한. 멤버가 아니면 존재 자체를 숨긴다(404)."""
    project = db.projects.get(project_id)
    access = resolve_access(db, project, user) if project else None
    if access is None or not access.can(Permission.VIEW):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return access


AccessDep = Annotated[Access, Depends(get_access)]


def get_project(access: AccessDep) -> Project:
    return access.project


ProjectDep = Annotated[Project, Depends(get_project)]


def require(perm: Permission):
    """라우트 dependencies=[require(Permission.X)] 로 권한을 강제한다 (없으면 403)."""

    def check(access: AccessDep) -> Access:
        if not access.can(perm):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"'{perm.value}' permission required")
        return access

    return Depends(check)


def get_task(task_id: str, project: ProjectDep, db: DbDep) -> Task:
    """경로의 {task_id} 를 현재 프로젝트의 일감으로 변환. 다른 프로젝트 일감이면 404."""
    task = db.tasks.get(task_id)
    if task is None or task.project_id != project.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


TaskDep = Annotated[Task, Depends(get_task)]

E = TypeVar("E", bound=Entity)


def apply_patch(entity: E, patch: BaseModel, **extra) -> E:
    """PATCH 요청에서 보낸 필드만 반영하고 전체 모델을 다시 검증한다."""
    changes = patch.model_dump(exclude_unset=True)
    data = {**entity.model_dump(), **changes, **extra, "updated_at": utcnow()}
    try:
        return type(entity).model_validate(data)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=e.errors(include_url=False, include_context=False, include_input=False))
