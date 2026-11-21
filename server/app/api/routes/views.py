"""프로젝트별 저장된 뷰(Custom Views) API."""

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import AccessDep, CurrentUser, DbDep, ProjectDep, require
from app.models.member import Permission
from app.models.view import SavedView, SavedViewCreate

router = APIRouter(prefix="/projects/{project_id}/views", tags=["views"])


@router.get("", response_model=list[SavedView])
def list_views(project: ProjectDep, db: DbDep) -> list[SavedView]:
    return sorted(db.saved_views.list(lambda v: v.project_id == project.id), key=lambda v: v.created_at)


@router.post("", response_model=SavedView, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_view(project: ProjectDep, body: SavedViewCreate, user: CurrentUser, db: DbDep) -> SavedView:
    return db.saved_views.create(
        SavedView(project_id=project.id, name=body.name.strip(), layout=body.layout, filters=body.filters, created_by=user.id)
    )


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(access: AccessDep, view_id: str, user: CurrentUser, db: DbDep) -> Response:
    v = db.saved_views.get(view_id)
    if v is None or v.project_id != access.project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "View not found")
    if v.created_by != user.id and not access.can(Permission.DELETE) and not access.can(Permission.ADMIN):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed to delete this view")
    db.saved_views.delete(v.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
