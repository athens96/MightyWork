from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, DbDep, ProjectDep, SettingsDep, get_invite_sender, require
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
from app.services.audit import record_audit
from app.services.email import InviteSender
from app.services.notifications import notify_user

router = APIRouter(prefix="/projects/{project_id}/members", tags=["members"])


def _user_by_email(db: Database, email: str):
    found = db.users.list(lambda u: u.email.lower() == email)
    return found[0] if found else None


def _read(db: Database, m: ProjectMember, *, invite_status: str | None = None) -> MemberRead:
    user = _user_by_email(db, m.email)
    return MemberRead(
        id=m.id,
        email=m.email,
        user=user,
        permissions=normalize_permissions(m.permissions),
        pending=user is None,
        invite_status=invite_status,
    )


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
async def add_member(
    project: ProjectDep,
    body: MemberCreate,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
    sender: Annotated[InviteSender, Depends(get_invite_sender)],
) -> MemberRead:
    owner = db.users.get(project.created_by)
    exists = db.project_members.list(lambda m: m.project_id == project.id and m.email == body.email)
    if exists or (owner and owner.email.lower() == body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "Already a member")
    perms = normalize_permissions(body.permissions)
    member = db.project_members.create(
        ProjectMember(project_id=project.id, email=body.email, permissions=perms, added_by=user.id)
    )
    invite_status: str | None = None
    if body.send_invite:
        invite_status = await run_in_threadpool(sender, settings, member.email, project, user, perms)
    invited_user = _user_by_email(db, member.email)
    if invited_user is not None:
        notify_user(
            db,
            user_id=invited_user.id,
            project_id=project.id,
            actor_id=user.id,
            kind="invite",
            title=f"'{project.name}' ({project.key}) 프로젝트에 초대되었습니다",
            link=f"/projects/{project.id}/tasks",
        )
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="member.added",
        target_type="member",
        target_id=member.id,
        summary=f"멤버 추가: {member.email}",
        details={"permissions": [p.value for p in perms], "invite_status": invite_status},
    )
    return _read(db, member, invite_status=invite_status)


@router.post("/{member_id}/resend-invite", response_model=MemberRead, dependencies=[require(Permission.ADMIN)])
async def resend_invite(
    project: ProjectDep,
    member_id: str,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
    sender: Annotated[InviteSender, Depends(get_invite_sender)],
) -> MemberRead:
    m = _get_member(db, project, member_id)
    perms = normalize_permissions(m.permissions)
    invite_status = await run_in_threadpool(sender, settings, m.email, project, user, perms)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="member.invite_resent",
        target_type="member",
        target_id=m.id,
        summary=f"초대 메일 재발송: {m.email} ({invite_status})",
        details={"invite_status": invite_status},
    )
    return _read(db, m, invite_status=invite_status)


@router.patch("/{member_id}", response_model=MemberRead, dependencies=[require(Permission.ADMIN)])
def update_member(project: ProjectDep, member_id: str, body: MemberUpdate, user: CurrentUser, db: DbDep) -> MemberRead:
    m = _get_member(db, project, member_id)
    perms = normalize_permissions(body.permissions)
    updated = m.model_copy(update={"permissions": perms, "updated_at": utcnow()})
    db.project_members.update(updated)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="member.updated",
        target_type="member",
        target_id=m.id,
        summary=f"멤버 권한 변경: {m.email}",
        details={"old": [p.value for p in m.permissions], "new": [p.value for p in perms]},
    )
    return _read(db, updated)


@router.delete("/{member_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.ADMIN)])
def remove_member(project: ProjectDep, member_id: str, user: CurrentUser, db: DbDep) -> Response:
    """멤버 제거. 그 사람이 작업자/문서 담당자인 일감·위키는 '미지정'으로 바뀐다."""
    m = _get_member(db, project, member_id)
    db.project_members.delete(m.id)
    target_user = _user_by_email(db, m.email)
    if target_user:
        for t in db.tasks.list(lambda t: t.project_id == project.id and t.assignee_id == target_user.id):
            db.tasks.update(t.model_copy(update={"assignee_id": None, "updated_at": utcnow()}))
        for p in db.wiki_pages.list(lambda p: p.project_id == project.id and p.owner_id == target_user.id):
            db.wiki_pages.update(p.model_copy(update={"owner_id": None}))
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="member.removed",
        target_type="member",
        target_id=m.id,
        summary=f"멤버 제거: {m.email}",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
