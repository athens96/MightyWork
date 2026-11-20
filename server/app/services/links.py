"""위키 문서 구조화: [[페이지]] 링크, 백링크, 일감 키(KEY-n) 언급, 제목 변경 시 링크 갱신.

인덱스를 따로 저장하지 않고 요청 시 계산한다(프로젝트 단위 문서 수가 작은 파일 DB 전제).
DB 이전 시 links 테이블로 물질화하면 된다.
"""

import re

from app.db import Database
from app.models.project import Project
from app.models.task import Task
from app.models.wiki import WikiPage

# [[제목]] 또는 [[제목|표시 텍스트]]
WIKI_LINK = re.compile(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]")
# 코드 블록·인라인 코드 안의 텍스트는 링크로 보지 않는다
_CODE = re.compile(r"```.*?```|`[^`\n]*`", re.S)


def norm_title(title: str) -> str:
    return " ".join(title.split()).casefold()


def _strip_code(md: str) -> str:
    return _CODE.sub(" ", md)


def link_targets(md: str) -> list[str]:
    """본문의 [[...]] 대상 제목들 (등장 순서, 중복 제거)."""
    seen, out = set(), []
    for m in WIKI_LINK.finditer(_strip_code(md)):
        key = norm_title(m.group(1))
        if key and key not in seen:
            seen.add(key)
            out.append(m.group(1).strip())
    return out


def task_numbers(md: str, project_key: str) -> list[int]:
    """본문에서 이 프로젝트의 일감 키(예: TEST-12) 번호들."""
    pattern = re.compile(rf"(?<![A-Za-z0-9_-]){re.escape(project_key)}-(\d+)(?![A-Za-z0-9_])")
    seen, out = set(), []
    for m in pattern.finditer(_strip_code(md)):
        n = int(m.group(1))
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def pages_by_title(pages: list[WikiPage]) -> dict[str, WikiPage]:
    """제목 → 페이지. 같은 제목이 여럿이면 가장 먼저 만든 페이지."""
    result: dict[str, WikiPage] = {}
    for p in sorted(pages, key=lambda p: p.created_at):
        result.setdefault(norm_title(p.title), p)
    return result


def project_pages(db: Database, project: Project) -> list[WikiPage]:
    return db.wiki_pages.list(lambda p: p.project_id == project.id)


def backlinks(db: Database, project: Project, page: WikiPage) -> list[WikiPage]:
    key = norm_title(page.title)
    return [
        p
        for p in project_pages(db, project)
        if p.id != page.id and key in {norm_title(t) for t in link_targets(p.content)}
    ]


def pages_mentioning_task(db: Database, project: Project, task: Task) -> list[WikiPage]:
    return [p for p in project_pages(db, project) if task.number in task_numbers(p.content, project.key)]


def rename_links(md: str, old_title: str, new_title: str) -> str:
    """[[old]] / [[old|별칭]] 을 새 제목으로 바꾼다 (별칭 유지, 대소문자·공백 무시)."""
    old_key = norm_title(old_title)

    def repl(m: re.Match) -> str:
        if norm_title(m.group(1)) != old_key:
            return m.group(0)
        alias = m.group(2)
        return f"[[{new_title}|{alias}]]" if alias is not None else f"[[{new_title}]]"

    return WIKI_LINK.sub(repl, md)


def propagate_rename(db: Database, project: Project, page: WikiPage, old_title: str) -> int:
    """다른 위키 페이지와 일감 설명 속 링크를 새 제목으로 갱신. 바뀐 문서 수를 반환.
    자동 정리이므로 updated_at 은 건드리지 않는다."""
    if norm_title(old_title) == norm_title(page.title):
        return 0
    changed = 0
    for p in project_pages(db, project):
        if p.id == page.id:
            continue
        new = rename_links(p.content, old_title, page.title)
        if new != p.content:
            db.wiki_pages.update(p.model_copy(update={"content": new}))
            changed += 1
    for t in db.tasks.list(lambda t: t.project_id == project.id):
        new = rename_links(t.description, old_title, page.title)
        if new != t.description:
            db.tasks.update(t.model_copy(update={"description": new}))
            changed += 1
    return changed
