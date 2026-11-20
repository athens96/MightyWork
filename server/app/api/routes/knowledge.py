"""문서 구조화 API: 위키 링크·백링크, 일감↔위키 연결, 프로젝트 검색. 모두 보기 권한."""

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.api.deps import DbDep, ProjectDep, TaskDep
from app.models.task import PipelineStage
from app.models.wiki import WikiPageSummary
from app.services.links import (
    backlinks,
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
