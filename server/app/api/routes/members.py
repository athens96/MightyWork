from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, require
from app.db import Database
from app.models.common import utcnow
from app.models.member import (
    MemberCreate,
    MemberRead,
    MemberUpdate,
    Permission,
    ProjectMember,
    normalize_permissions,
)
from app.models.project import Project

router = APIRouter(prefix="/projects/{project_id}/members", tags=["members"])


def _user_by_email(db: Database, email: str):
    found = db.users.list(lambda u: u.email.lower() == email)
    return found[0] if found else None


def _read(db: Database, m: ProjectMember) -> MemberRead:
    user = _user_by_email(db, m.email)
    return MemberRead(id=m.id, email=m.email, user=user, permissions=normalize_permissions(m.permissions), pending=user is None)


def _owner(db: Database, project: Project) -> MemberRead:
    owner = db.users.get(project.created_by)
    return MemberRead(id="owner", email=owner.email if owner else "", user=owner, permissions=list(Permission), is_owner=True)


def _get_member(db: Database, project: Project, member_id: str) -> ProjectMember:
    if member_id == "owner":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The project owner cannot be changed")
    m = db.project_members.get(member_id)
    if m is None or m.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    return m


@router.get("", response_model=list[MemberRead])
def list_members(project: ProjectDep, db: DbDep) -> list[MemberRead]:
    """소유자가 맨 앞, 나머지는 추가된 순."""
    members = sorted(db.project_members.list(lambda m: m.project_id == project.id), key=lambda m: m.created_at)
    return [_owner(db, project), *(_read(db, m) for m in members)]


@router.post("", response_model=MemberRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.ADMIN)])
def add_member(project: ProjectDep, body: MemberCreate, user: CurrentUser, db: DbDep) -> MemberRead:
    owner = db.users.get(project.created_by)
    exists = db.project_members.list(lambda m: m.project_id == project.id and m.email == body.email)
    if exists or (owner and owner.email.lower() == body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "Already a member")
    member = db.project_members.create(
        ProjectMember(project_id=project.id, email=body.email, permissions=normalize_permissions(body.permissions), added_by=user.id)
    )
    return _read(db, member)


@router.patch("/{member_id}", response_model=MemberRead, dependencies=[require(Permission.ADMIN)])
def update_member(project: ProjectDep, member_id: str, body: MemberUpdate, db: DbDep) -> MemberRead:
    m = _get_member(db, project, member_id)
    updated = m.model_copy(update={"permissions": normalize_permissions(body.permissions), "updated_at": utcnow()})
    db.project_members.update(updated)
    return _read(db, updated)


@router.delete("/{member_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.ADMIN)])
def remove_member(project: ProjectDep, member_id: str, db: DbDep) -> Response:
    """멤버 제거. 그 사람이 작업자/문서 담당자인 일감·위키는 '미지정'으로 바뀐다."""
    m = _get_member(db, project, member_id)
    db.project_members.delete(m.id)
    user = _user_by_email(db, m.email)
    if user:
        for t in db.tasks.list(lambda t: t.project_id == project.id and t.assignee_id == user.id):
            db.tasks.update(t.model_copy(update={"assignee_id": None, "updated_at": utcnow()}))
        for p in db.wiki_pages.list(lambda p: p.project_id == project.id and p.owner_id == user.id):
            db.wiki_pages.update(p.model_copy(update={"owner_id": None}))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
