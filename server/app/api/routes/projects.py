from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import AccessDep, CurrentUser, DbDep, apply_patch, require
from app.models.member import Permission
from app.models.project import Project, ProjectCreate, ProjectRead, ProjectUpdate
from app.services.access import Access, accessible_projects
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
    return _read(Access(project, user, tuple(Permission), is_owner=True))


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(access: AccessDep) -> ProjectRead:
    return _read(access)


@router.patch("/{project_id}", response_model=ProjectRead, dependencies=[require(Permission.ADMIN)])
def update_project(access: AccessDep, body: ProjectUpdate, db: DbDep) -> ProjectRead:
    with project_write_lock:
        latest = db.projects.get(access.project.id) or access.project  # task_seq 최신값 유지
        updated = apply_patch(latest, body)
        db.projects.update(updated)
    return _read(access, updated)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(access: AccessDep, db: DbDep) -> Response:
    """소유자만 삭제할 수 있다. 일감·덧글·이력·위키·멤버가 모두 함께 삭제된다."""
    if not access.is_owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the project owner can delete the project")
    delete_project_cascade(db, access.project.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
