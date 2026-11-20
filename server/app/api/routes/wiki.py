from fastapi import APIRouter, HTTPException, Query, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, apply_patch, require
from app.db import Database
from app.models.member import Permission
from app.models.project import Project
from app.models.wiki import PageStatus, PageType, WikiPage, WikiPageCreate, WikiPageSummary, WikiPageUpdate
from app.services.access import is_member_user
from app.services.links import propagate_rename

router = APIRouter(prefix="/projects/{project_id}/wiki/pages", tags=["wiki"])


def _get_or_404(db: Database, project: Project, page_id: str) -> WikiPage:
    page = db.wiki_pages.get(page_id)
    if page is None or page.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    return page


def _validate_parent(db: Database, project: Project, page_id: str | None, parent_id: str | None) -> None:
    """부모가 같은 프로젝트에 존재하는지, 자기 자신/하위 페이지 밑으로 들어가 순환이 생기지 않는지 확인."""
    current = parent_id
    while current is not None:
        if current == page_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Page cannot be nested under itself")
        parent = db.wiki_pages.get(current)
        if parent is None or parent.project_id != project.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Parent page not found")
        current = parent.parent_id


def _ensure_owner_is_member(db: Database, project: Project, owner_id: str | None) -> None:
    if owner_id is not None and not is_member_user(db, project, owner_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Owner must be a project member")


@router.get("", response_model=list[WikiPageSummary])
def list_pages(
    project: ProjectDep,
    db: DbDep,
    page_type: PageType | None = None,
    page_status: PageStatus | None = Query(None, alias="status"),
    tag: str | None = None,
    owner_id: str | None = None,
) -> list[WikiPageSummary]:
    """페이지 목록(본문 제외). Properties 로 거를 수 있다 (옵시디언 Bases 처럼)."""
    tag_key = tag.casefold() if tag else None
    pages = db.wiki_pages.list(
        lambda p: p.project_id == project.id
        and (page_type is None or p.page_type == page_type)
        and (page_status is None or p.status == page_status)
        and (tag_key is None or tag_key in {t.casefold() for t in p.tags})
        and (owner_id is None or p.owner_id == owner_id)
    )
    return [WikiPageSummary(**p.model_dump()) for p in sorted(pages, key=lambda p: p.created_at)]


@router.post("", response_model=WikiPage, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_page(project: ProjectDep, body: WikiPageCreate, user: CurrentUser, db: DbDep) -> WikiPage:
    _validate_parent(db, project, None, body.parent_id)
    _ensure_owner_is_member(db, project, body.owner_id)
    return db.wiki_pages.create(
        WikiPage(**body.model_dump(), project_id=project.id, created_by=user.id, updated_by=user.id)
    )


@router.get("/{page_id}", response_model=WikiPage)
def get_page(project: ProjectDep, page_id: str, db: DbDep) -> WikiPage:
    return _get_or_404(db, project, page_id)


@router.patch("/{page_id}", response_model=WikiPage, dependencies=[require(Permission.EDIT)])
def update_page(project: ProjectDep, page_id: str, body: WikiPageUpdate, user: CurrentUser, db: DbDep) -> WikiPage:
    page = _get_or_404(db, project, page_id)
    if "parent_id" in body.model_fields_set:
        _validate_parent(db, project, page_id, body.parent_id)
    if "owner_id" in body.model_fields_set:
        _ensure_owner_is_member(db, project, body.owner_id)
    updated = apply_patch(page, body, updated_by=user.id)
    db.wiki_pages.update(updated)
    propagate_rename(db, project, updated, page.title)  # 다른 문서의 [[옛 제목]] → [[새 제목]]
    return updated


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_page(project: ProjectDep, page_id: str, db: DbDep) -> Response:
    _get_or_404(db, project, page_id)
    if db.wiki_pages.list(lambda p: p.parent_id == page_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Delete or move child pages first")
    db.wiki_pages.delete(page_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
