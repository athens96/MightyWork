"""문서 구조화 API: 위키 링크·백링크, 일감↔위키 연결, 링크 안 된 언급, 프로젝트 검색."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, DbDep, ProjectDep, TaskDep, require
from app.models.common import utcnow
from app.models.member import Permission
from app.models.task import PipelineStage
from app.models.wiki import WikiPageSummary
from app.services.links import (
    backlinks,
    find_mentions,
    link_mentions,
    mention_snippets,
    page_names,
    link_targets,
    norm_title,
    pages_by_title,
    pages_mentioning_task,
    project_pages,
    task_numbers,
)
from app.services.search import SearchHit, search

router = APIRouter(prefix="/projects/{project_id}", tags=["knowledge"])


class OutgoingLink(BaseModel):
    title: str
    page_id: str | None  # 없는 페이지면 None


class TaskRef(BaseModel):
    id: str
    number: int
    title: str
    stage: PipelineStage


class PageLinks(BaseModel):
    outgoing: list[OutgoingLink]  # 이 문서가 링크한 문서
    backlinks: list[WikiPageSummary]  # 이 문서를 링크한 문서
    tasks: list[TaskRef]  # 이 문서가 언급한 일감
    missing_tasks: list[int]  # 언급했지만 없는 일감 번호


@router.get("/wiki/pages/{page_id}/links", response_model=PageLinks)
def page_links(project: ProjectDep, page_id: str, db: DbDep) -> PageLinks:
    page = db.wiki_pages.get(page_id)
    if page is None or page.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    by_title = pages_by_title(project_pages(db, project))
    outgoing = [OutgoingLink(title=t, page_id=(p.id if (p := by_title.get(norm_title(t))) else None)) for t in link_targets(page.content)]
    tasks_by_number = {t.number: t for t in db.tasks.list(lambda t: t.project_id == project.id)}
    numbers = task_numbers(page.content, project.key)
    return PageLinks(
        outgoing=outgoing,
        backlinks=[WikiPageSummary(**p.model_dump()) for p in sorted(backlinks(db, project, page), key=lambda p: p.title)],
        tasks=[TaskRef(**tasks_by_number[n].model_dump(include={"id", "number", "title", "stage"})) for n in numbers if n in tasks_by_number],
        missing_tasks=[n for n in numbers if n not in tasks_by_number],
    )


@router.get("/tasks/{task_id}/wiki-refs", response_model=list[WikiPageSummary])
def task_wiki_refs(project: ProjectDep, task: TaskDep, db: DbDep) -> list[WikiPageSummary]:
    """이 일감의 키(예: TEST-12)를 언급한 위키 페이지."""
    return [WikiPageSummary(**p.model_dump()) for p in sorted(pages_mentioning_task(db, project, task), key=lambda p: p.title)]


@router.get("/search", response_model=list[SearchHit])
def project_search(project: ProjectDep, db: DbDep, q: str = Query(min_length=1, max_length=200), limit: int = Query(30, ge=1, le=100)) -> list[SearchHit]:
    return search(db, project, q, limit)


class UnlinkedMention(BaseModel):
    source_type: Literal["wiki", "task"]
    source_id: str
    title: str  # 위키 제목 또는 일감 제목
    number: int | None = None  # 일감 번호
    count: int
    snippets: list[str]


def _page_or_404(db, project, page_id):
    page = db.wiki_pages.get(page_id)
    if page is None or page.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    return page


@router.get("/wiki/pages/{page_id}/unlinked-mentions", response_model=list[UnlinkedMention])
def unlinked_mentions(project: ProjectDep, page_id: str, db: DbDep) -> list[UnlinkedMention]:
    """다른 위키·일감 설명에서 이 페이지의 제목/별칭이 링크 없이 적힌 곳 (옵시디언 Unlinked mentions)."""
    page = _page_or_404(db, project, page_id)
    names = page_names(page)
    result: list[UnlinkedMention] = []
    for p in project_pages(db, project):
        if p.id == page.id:
            continue
        spans = find_mentions(p.content, names)
        if spans:
            result.append(UnlinkedMention(source_type="wiki", source_id=p.id, title=p.title, count=len(spans), snippets=mention_snippets(p.content, spans)))
    for t in db.tasks.list(lambda t: t.project_id == project.id):
        spans = find_mentions(t.description, names)
        if spans:
            result.append(UnlinkedMention(source_type="task", source_id=t.id, title=t.title, number=t.number, count=len(spans), snippets=mention_snippets(t.description, spans)))
    return sorted(result, key=lambda m: -m.count)


class UnlinkedMentionRef(BaseModel):
    source_type: Literal["wiki", "task"]
    source_id: str


class LinkMentionsRequest(BaseModel):
    sources: list[UnlinkedMentionRef]


class LinkMentionsResult(BaseModel):
    linked: int  # 바뀐 언급 수
    documents: int  # 바뀐 문서 수


@router.post("/wiki/pages/{page_id}/unlinked-mentions/link", response_model=LinkMentionsResult, dependencies=[require(Permission.EDIT)])
def link_unlinked_mentions(project: ProjectDep, page_id: str, body: LinkMentionsRequest, user: CurrentUser, db: DbDep) -> LinkMentionsResult:
    """선택한 문서들의 링크 안 된 언급을 [[링크]] 로 바꾼다."""
    page = _page_or_404(db, project, page_id)
    names, linked, documents = page_names(page), 0, 0
    for ref in body.sources:
        if ref.source_type == "wiki":
            doc = db.wiki_pages.get(ref.source_id)
            if doc is None or doc.project_id != project.id or doc.id == page.id:
                continue
            n = len(find_mentions(doc.content, names))
            if n:
                db.wiki_pages.update(doc.model_copy(update={"content": link_mentions(doc.content, page), "updated_by": user.id, "updated_at": utcnow()}))
        else:
            doc = db.tasks.get(ref.source_id)
            if doc is None or doc.project_id != project.id:
                continue
            n = len(find_mentions(doc.description, names))
            if n:
                db.tasks.update(doc.model_copy(update={"description": link_mentions(doc.description, page), "updated_at": utcnow()}))
        linked += n
        documents += 1 if n else 0
    return LinkMentionsResult(linked=linked, documents=documents)
