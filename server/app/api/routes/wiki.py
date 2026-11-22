from fastapi import APIRouter, HTTPException, Query, Response, status

from app.api.deps import AccessDep, CurrentUser, DbDep, ProjectDep, apply_patch, require
from app.db import Database
from app.models.common import utcnow
from app.models.member import Permission
from app.models.project import Project
from app.models.wiki import (
    PageStatus,
    PageType,
    WikiComment,
    WikiCommentCreate,
    WikiCommentUpdate,
    WikiPage,
    WikiPageCreate,
    WikiPageSummary,
    WikiPageUpdate,
    WikiRevisionDetail,
    WikiRevisionSummary,
)
from app.services.access import is_member_user
from app.services.audit import record_audit
from app.services.events import publish_event
from app.services.links import link_targets, norm_title, pages_by_title, propagate_rename
from app.services.notifications import notify_mentions, notify_user
from app.services.wiki_revisions import line_diff, list_revisions, record_revision

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
    all_pages = db.wiki_pages.list(lambda p: p.project_id == project.id)
    by_title = pages_by_title(all_pages)
    backlink_counts: dict[str, int] = {}
    broken_counts: dict[str, int] = {}
    for p in all_pages:
        linked_ids: set[str] = set()
        broken = 0
        for raw_target in link_targets(p.content):
            resolved = by_title.get(norm_title(raw_target))
            if resolved is None:
                broken += 1
            elif resolved.id != p.id:
                linked_ids.add(resolved.id)
        if broken:
            broken_counts[p.id] = broken
        for tid in linked_ids:
            backlink_counts[tid] = backlink_counts.get(tid, 0) + 1

    pages = [
        p
        for p in all_pages
        if (page_type is None or p.page_type == page_type)
        and (page_status is None or p.status == page_status)
        and (tag_key is None or tag_key in {t.casefold() for t in p.tags})
        and (owner_id is None or p.owner_id == owner_id)
    ]
    return [
        WikiPageSummary(
            **p.model_dump(),
            backlink_count=backlink_counts.get(p.id, 0),
            broken_link_count=broken_counts.get(p.id, 0),
        )
        for p in sorted(pages, key=lambda p: p.created_at)
    ]


@router.post("", response_model=WikiPage, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_page(project: ProjectDep, body: WikiPageCreate, user: CurrentUser, db: DbDep) -> WikiPage:
    _validate_parent(db, project, None, body.parent_id)
    _ensure_owner_is_member(db, project, body.owner_id)
    page = db.wiki_pages.create(
        WikiPage(**body.model_dump(), project_id=project.id, created_by=user.id, updated_by=user.id)
    )
    record_revision(db, page, user.id, note="초기 작성")
    notify_mentions(
        db,
        project=project,
        actor=user,
        text=page.content,
        title=f"위키 '{page.title}' 에서 나를 언급했습니다",
        link=f"/projects/{project.id}/wiki/{page.id}",
    )
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="wiki.created",
        target_type="wiki",
        target_id=page.id,
        summary=f"위키 '{page.title}' 생성",
    )
    return page


@router.get("/{page_id}", response_model=WikiPage)
def get_page(project: ProjectDep, page_id: str, db: DbDep) -> WikiPage:
    return _get_or_404(db, project, page_id)


@router.patch("/{page_id}", response_model=WikiPage, dependencies=[require(Permission.EDIT)])
def update_page(project: ProjectDep, page_id: str, body: WikiPageUpdate, user: CurrentUser, db: DbDep) -> WikiPage:
    page = _get_or_404(db, project, page_id)
    if body.expected_updated_at is not None:
        if abs(page.updated_at.timestamp() - body.expected_updated_at.timestamp()) > 1e-6:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "다른 사용자가 이미 이 문서를 수정했습니다. 최신 내용을 확인한 뒤 다시 저장하세요.",
            )
    if "parent_id" in body.model_fields_set:
        _validate_parent(db, project, page_id, body.parent_id)
    if "owner_id" in body.model_fields_set:
        _ensure_owner_is_member(db, project, body.owner_id)
    updated = apply_patch(page, body, updated_by=user.id)
    db.wiki_pages.update(updated)
    if (
        updated.title != page.title
        or updated.content != page.content
        or updated.aliases != page.aliases
        or updated.page_type != page.page_type
        or updated.status != page.status
        or updated.tags != page.tags
    ):
        record_revision(db, updated, user.id)
    if updated.content != page.content:
        notify_mentions(
            db,
            project=project,
            actor=user,
            text=updated.content,
            title=f"위키 '{updated.title}' 에서 나를 언급했습니다",
            link=f"/projects/{project.id}/wiki/{updated.id}",
        )
    propagate_rename(db, project, updated, page.title)  # 다른 문서의 [[옛 제목]] → [[새 제목]]
    publish_event(db, project.id, "wiki.updated", {"page_id": updated.id})
    return updated


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_page(project: ProjectDep, page_id: str, user: CurrentUser, db: DbDep) -> Response:
    page = _get_or_404(db, project, page_id)
    if db.wiki_pages.list(lambda p: p.parent_id == page_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Delete or move child pages first")
    for rev in db.wiki_revisions.list(lambda r: r.page_id == page_id):
        db.wiki_revisions.delete(rev.id)
    for cmt in db.wiki_comments.list(lambda c: c.page_id == page_id):
        db.wiki_comments.delete(cmt.id)
    db.wiki_pages.delete(page_id)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="wiki.deleted",
        target_type="wiki",
        target_id=page.id,
        summary=f"위키 '{page.title}' 삭제",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- 위키 댓글 (토론·해결)


@router.get("/{page_id}/comments", response_model=list[WikiComment])
def list_page_comments(project: ProjectDep, page_id: str, db: DbDep) -> list[WikiComment]:
    _get_or_404(db, project, page_id)
    return sorted(db.wiki_comments.list(lambda c: c.page_id == page_id), key=lambda c: c.created_at)


@router.post("/{page_id}/comments", response_model=WikiComment, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_page_comment(project: ProjectDep, page_id: str, body: WikiCommentCreate, user: CurrentUser, db: DbDep) -> WikiComment:
    page = _get_or_404(db, project, page_id)
    comment = db.wiki_comments.create(
        WikiComment(project_id=project.id, page_id=page.id, author_id=user.id, body=body.body)
    )
    link = f"/projects/{project.id}/wiki/{page.id}"
    mentioned = notify_mentions(
        db,
        project=project,
        actor=user,
        text=comment.body,
        title=f"위키 '{page.title}' 댓글에서 나를 언급했습니다",
        link=link,
    )
    already = {n.user_id for n in mentioned}
    for uid in {page.owner_id, page.created_by}:
        if uid and uid not in already:
            notify_user(
                db,
                user_id=uid,
                project_id=project.id,
                actor_id=user.id,
                kind="comment",
                title=f"위키 '{page.title}' 에 새 댓글이 달렸습니다",
                body=" ".join(comment.body.split())[:140],
                link=link,
            )
    publish_event(db, project.id, "wiki.comment_created", {"page_id": page.id, "comment_id": comment.id})
    return comment


@router.patch("/{page_id}/comments/{comment_id}", response_model=WikiComment)
def update_page_comment(
    access: AccessDep,
    project: ProjectDep,
    page_id: str,
    comment_id: str,
    body: WikiCommentUpdate,
    user: CurrentUser,
    db: DbDep,
) -> WikiComment:
    _get_or_404(db, project, page_id)
    comment = db.wiki_comments.get(comment_id)
    if comment is None or comment.page_id != page_id or comment.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    if "body" in body.model_fields_set and comment.author_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author can edit this comment")
    if "resolved" in body.model_fields_set and comment.author_id != user.id and not access.can(Permission.EDIT):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Edit permission required to resolve comment")
    extra: dict = {}
    if "resolved" in body.model_fields_set and body.resolved is not None:
        extra["resolved_by"] = user.id if body.resolved else None
    updated = apply_patch(comment, body, **extra)
    db.wiki_comments.update(updated)
    publish_event(db, project.id, "wiki.comment_updated", {"page_id": page_id, "comment_id": updated.id})
    return updated


@router.delete("/{page_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_page_comment(
    access: AccessDep,
    project: ProjectDep,
    page_id: str,
    comment_id: str,
    user: CurrentUser,
    db: DbDep,
) -> Response:
    _get_or_404(db, project, page_id)
    comment = db.wiki_comments.get(comment_id)
    if comment is None or comment.page_id != page_id or comment.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    if comment.author_id != user.id and not access.can(Permission.ADMIN):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author or admin can delete this comment")
    db.wiki_comments.delete(comment_id)
    publish_event(db, project.id, "wiki.comment_deleted", {"page_id": page_id, "comment_id": comment_id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- 버전 히스토리


@router.get("/{page_id}/revisions", response_model=list[WikiRevisionSummary])
def get_page_revisions(project: ProjectDep, page_id: str, db: DbDep) -> list[WikiRevisionSummary]:
    _get_or_404(db, project, page_id)
    return [WikiRevisionSummary(**r.model_dump()) for r in list_revisions(db, page_id)]


@router.get("/{page_id}/revisions/{rev_id}", response_model=WikiRevisionDetail)
def get_page_revision(project: ProjectDep, page_id: str, rev_id: str, db: DbDep) -> WikiRevisionDetail:
    page = _get_or_404(db, project, page_id)
    rev = db.wiki_revisions.get(rev_id)
    if rev is None or rev.page_id != page.id or rev.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Revision not found")
    return WikiRevisionDetail(**rev.model_dump(), diff_to_current=line_diff(rev.content, page.content))


@router.post("/{page_id}/revisions/{rev_id}/restore", response_model=WikiPage, dependencies=[require(Permission.EDIT)])
def restore_page_revision(project: ProjectDep, page_id: str, rev_id: str, user: CurrentUser, db: DbDep) -> WikiPage:
    page = _get_or_404(db, project, page_id)
    rev = db.wiki_revisions.get(rev_id)
    if rev is None or rev.page_id != page.id or rev.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Revision not found")
    restored = page.model_copy(
        update={
            "title": rev.title,
            "content": rev.content,
            "aliases": list(rev.aliases),
            "page_type": rev.page_type,
            "status": rev.status,
            "tags": list(rev.tags),
            "updated_by": user.id,
            "updated_at": utcnow(),
        }
    )
    db.wiki_pages.update(restored)
    record_revision(db, restored, user.id, note=f"v{rev.version} 복원")
    propagate_rename(db, project, restored, page.title)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="wiki.restored",
        target_type="wiki",
        target_id=page.id,
        summary=f"위키 '{restored.title}' v{rev.version} 으로 복원",
        details={"revision_id": rev.id, "version": rev.version},
    )
    return restored
