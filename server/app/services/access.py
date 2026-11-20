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


def project_related_users(db: Database, project: Project) -> list[User]:
    """프로젝트 멤버(소유자 포함)와 이 프로젝트의 일감·덧글·이력·위키에 등장하는 사용자만 반환."""
    member_emails = {m.email.lower() for m in db.project_members.list(lambda m: m.project_id == project.id)}
    ids: set[str] = {project.created_by}
    for t in db.tasks.list(lambda t: t.project_id == project.id):
        ids.add(t.created_by)
        if t.assignee_id:
            ids.add(t.assignee_id)
    for c in db.comments.list(lambda c: c.project_id == project.id):
        ids.add(c.author_id)
    for a in db.task_activities.list(lambda a: a.project_id == project.id):
        ids.add(a.actor_id)
    for p in db.wiki_pages.list(lambda p: p.project_id == project.id):
        ids.add(p.created_by)
        ids.add(p.updated_by)
        if p.owner_id:
            ids.add(p.owner_id)
    users = db.users.list(lambda u: u.id in ids or u.email.lower() in member_emails)
    return sorted(users, key=lambda u: u.name or u.email)


def visible_users_for(db: Database, user: User) -> list[User]:
    """현재 사용자와 같은 프로젝트에 속하거나 연관된 사용자만 노출 (전역 디렉터리 유출 방지)."""
    by_id: dict[str, User] = {user.id: user}
    for access in accessible_projects(db, user):
        for related in project_related_users(db, access.project):
            by_id[related.id] = related
    return sorted(by_id.values(), key=lambda u: u.name or u.email)
