from fastapi import APIRouter, HTTPException, Query, Response, status

from app.api.deps import AccessDep, CurrentUser, DbDep, apply_patch, require
from app.models.audit import AuditLog
from app.models.common import utcnow
from app.models.member import OwnershipTransferRequest, Permission, ProjectMember
from app.models.project import Project, ProjectCreate, ProjectRead, ProjectUpdate
from app.services.access import Access, accessible_projects, find_member
from app.services.audit import record_audit
from app.services.notifications import notify_user
from app.services.projects import delete_project_cascade, project_write_lock

router = APIRouter(prefix="/projects", tags=["projects"])


def _read(access: Access, project: Project | None = None) -> ProjectRead:
    return ProjectRead(
        **(project or access.project).model_dump(),
        my_permissions=list(access.permissions),
        is_owner=access.is_owner,
    )


@router.get("", response_model=list[ProjectRead])
def list_projects(user: CurrentUser, db: DbDep) -> list[ProjectRead]:
    """내가 소유하거나 멤버로 추가된 프로젝트만."""
    return [_read(a) for a in sorted(accessible_projects(db, user), key=lambda a: a.project.created_at)]


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, user: CurrentUser, db: DbDep) -> ProjectRead:
    """만든 사람이 소유자(관리자)가 된다."""
    with project_write_lock:
        if db.projects.list(lambda p: p.key == body.key):
            raise HTTPException(status.HTTP_409_CONFLICT, f"Project key '{body.key}' already exists")
        project = db.projects.create(Project(**body.model_dump(), created_by=user.id))
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="project.created",
        target_type="project",
        target_id=project.id,
        summary=f"프로젝트 '{project.name}' ({project.key}) 생성",
    )
    return _read(Access(project, user, tuple(Permission), is_owner=True))


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(access: AccessDep) -> ProjectRead:
    return _read(access)


@router.patch("/{project_id}", response_model=ProjectRead, dependencies=[require(Permission.ADMIN)])
def update_project(access: AccessDep, body: ProjectUpdate, user: CurrentUser, db: DbDep) -> ProjectRead:
    with project_write_lock:
        latest = db.projects.get(access.project.id) or access.project  # task_seq 최신값 유지
        updated = apply_patch(latest, body)
        db.projects.update(updated)
    record_audit(
        db,
        project_id=updated.id,
        actor_id=user.id,
        action="project.updated",
        target_type="project",
        target_id=updated.id,
        summary=f"프로젝트 정보 수정: {updated.name}",
    )
    return _read(access, updated)


@router.post("/{project_id}/transfer-ownership", response_model=ProjectRead)
def transfer_ownership(access: AccessDep, body: OwnershipTransferRequest, user: CurrentUser, db: DbDep) -> ProjectRead:
    """프로젝트 소유권 이전 (소유자만 가능, 대상은 로그인한 기존 멤버여야 함). 이전 소유자는 관리자 멤버로 전환."""
    if not access.is_owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the project owner can transfer ownership")
    if body.new_owner_user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You are already the project owner")
    target_user = db.users.get(body.new_owner_user_id)
    if target_user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Target user not found")

    with project_write_lock:
        latest = db.projects.get(access.project.id)
        if latest is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        target_member = find_member(db, latest.id, target_user.email)
        if target_member is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "New owner must be an existing project member")
        # 1) 새 소유자는 project_members 에서 제거하고 created_by 로 승격
        db.project_members.delete(target_member.id)
        # 2) 기존 소유자는 관리자 권한의 일반 멤버로 유지
        if find_member(db, latest.id, user.email) is None:
            db.project_members.create(
                ProjectMember(project_id=latest.id, email=user.email.lower(), permissions=list(Permission), added_by=target_user.id)
            )
        updated = latest.model_copy(update={"created_by": target_user.id, "updated_at": utcnow()})
        db.projects.update(updated)

    notify_user(
        db,
        user_id=target_user.id,
        project_id=updated.id,
        actor_id=user.id,
        kind="ownership",
        title=f"'{updated.name}' ({updated.key}) 프로젝트의 소유권을 넘겨받았습니다",
        link=f"/projects/{updated.id}/members",
    )
    record_audit(
        db,
        project_id=updated.id,
        actor_id=user.id,
        action="project.ownership_transferred",
        target_type="project",
        target_id=updated.id,
        summary=f"소유권 이전: {user.email} → {target_user.email}",
        details={"from_user_id": user.id, "to_user_id": target_user.id},
    )
    return _read(Access(updated, user, tuple(Permission), is_owner=False), updated)


@router.get("/{project_id}/audit-logs", response_model=list[AuditLog], dependencies=[require(Permission.ADMIN)])
def list_audit_logs(
    access: AccessDep,
    db: DbDep,
    action: str | None = None,
    limit: int = Query(100, ge=1, le=500),
) -> list[AuditLog]:
    """프로젝트 감사 로그 (관리자 전용, 최신순)."""
    logs = db.audit_logs.list(
        lambda a: a.project_id == access.project.id and (action is None or a.action == action or a.action.startswith(f"{action}."))
    )
    return sorted(logs, key=lambda a: a.created_at, reverse=True)[:limit]


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(access: AccessDep, db: DbDep) -> Response:
    """소유자만 삭제할 수 있다. 일감·덧글·이력·위키·멤버가 모두 함께 삭제된다."""
    if not access.is_owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the project owner can delete the project")
    delete_project_cascade(db, access.project.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
