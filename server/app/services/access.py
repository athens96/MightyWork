from dataclasses import dataclass

from app.db import Database
from app.models.member import Permission, ProjectMember, normalize_permissions
from app.models.project import Project
from app.models.user import User


@dataclass(frozen=True)
class Access:
    """현재 사용자의 프로젝트 권한."""

    project: Project
    user: User
    permissions: tuple[Permission, ...]
    is_owner: bool

    def can(self, perm: Permission) -> bool:
        return perm in self.permissions


def find_member(db: Database, project_id: str, email: str) -> ProjectMember | None:
    email = email.lower()
    found = db.project_members.list(lambda m: m.project_id == project_id and m.email == email)
    return found[0] if found else None


def resolve_access(db: Database, project: Project, user: User) -> Access:
    if project.created_by == user.id:
        return Access(project, user, tuple(Permission), is_owner=True)
    member = find_member(db, project.id, user.email)
    perms = tuple(normalize_permissions(member.permissions)) if member else ()
    return Access(project, user, perms, is_owner=False)


def accessible_projects(db: Database, user: User) -> list[Access]:
    result = [resolve_access(db, p, user) for p in db.projects.list()]
    return [a for a in result if a.can(Permission.VIEW)]


def is_member_user(db: Database, project: Project, user_id: str) -> bool:
    """작업자 지정 가능 여부: 소유자이거나, 로그인한 적 있는 멤버."""
    if project.created_by == user_id:
        return True
    user = db.users.get(user_id)
    return user is not None and find_member(db, project.id, user.email) is not None
