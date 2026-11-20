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
_CODE_SPLIT = re.compile(r"(```.*?```|`[^`\n]*`)", re.S)


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


def page_names(page: WikiPage) -> list[str]:
    """페이지를 가리키는 이름들: 제목 + 별칭."""
    return [page.title, *page.aliases]


def pages_by_title(pages: list[WikiPage]) -> dict[str, WikiPage]:
    """이름 → 페이지. 제목이 별칭보다 우선하고, 같은 이름이 여럿이면 가장 먼저 만든 페이지."""
    result: dict[str, WikiPage] = {}
    ordered = sorted(pages, key=lambda p: p.created_at)
    for p in ordered:
        result.setdefault(norm_title(p.title), p)
    for p in ordered:
        for alias in p.aliases:
            result.setdefault(norm_title(alias), p)
    return result


def project_pages(db: Database, project: Project) -> list[WikiPage]:
    return db.wiki_pages.list(lambda p: p.project_id == project.id)


def backlinks(db: Database, project: Project, page: WikiPage) -> list[WikiPage]:
    """이 페이지(제목 또는 별칭으로 실제 해석되는)를 링크한 페이지."""
    pages = project_pages(db, project)
    by_title = pages_by_title(pages)

    def points_here(title: str) -> bool:
        target = by_title.get(norm_title(title))
        return target is not None and target.id == page.id

    return [p for p in pages if p.id != page.id and any(points_here(t) for t in link_targets(p.content))]


def pages_mentioning_task(db: Database, project: Project, task: Task) -> list[WikiPage]:
    return [p for p in project_pages(db, project) if task.number in task_numbers(p.content, project.key)]


def rename_links(md: str, old_title: str, new_title: str) -> str:
    """[[old]] / [[old|별칭]] 을 새 제목으로 바꾼다 (별칭 유지, 대소문자·공백 무시, 코드 블록 제외)."""
    old_key = norm_title(old_title)

    def repl(m: re.Match) -> str:
        if norm_title(m.group(1)) != old_key:
            return m.group(0)
        alias = m.group(2)
        return f"[[{new_title}|{alias}]]" if alias is not None else f"[[{new_title}]]"

    # 코드 블록·인라인 코드 안의 [[...]] 예시는 건드리지 않는다
    parts = _CODE_SPLIT.split(md)
    return "".join(p if i % 2 else WIKI_LINK.sub(repl, p) for i, p in enumerate(parts))


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


# ---------------------------------------------------------------- 링크 안 된 언급

# 언급으로 보지 않을 영역: 코드, 기존 [[링크]], [텍스트](url) 링크
_MASK = re.compile(r"```.*?```|`[^`\n]*`|\[\[[^\[\]\n]*\]\]|\[[^\[\]\n]*\]\([^)\n]*\)", re.S)


def _masked(md: str) -> str:
    """언급 검사용: 제외 영역을 같은 길이의 공백으로 덮어 위치(index)를 보존."""
    return _MASK.sub(lambda m: " " * len(m.group(0)), md)


def _names_pattern(names: list[str]) -> re.Pattern | None:
    names = sorted({n for n in names if len(n.strip()) >= 2}, key=len, reverse=True)  # 긴 이름 먼저
    if not names:
        return None
    alts = "|".join(r"\s+".join(map(re.escape, n.split())) for n in names)
    # 영문·숫자 단어 중간은 제외. 한글 조사(…를, …에서)는 바로 붙어도 언급으로 본다.
    return re.compile(rf"(?<![A-Za-z0-9_])(?:{alts})(?![A-Za-z0-9_])", re.IGNORECASE)


def find_mentions(md: str, names: list[str]) -> list[tuple[int, int, str]]:
    pattern = _names_pattern(names)
    if pattern is None:
        return []
    masked = _masked(md)
    return [(m.start(), m.end(), md[m.start() : m.end()]) for m in pattern.finditer(masked)]


def mention_snippets(md: str, spans: list[tuple[int, int, str]], width: int = 40, limit: int = 2) -> list[str]:
    out, covered_until = [], -1
    for start, end, _ in spans:
        if start < covered_until:  # 앞 미리보기 범위에 이미 포함된 언급은 건너뜀
            continue
        a, b = max(0, start - width), min(len(md), end + width)
        out.append(("…" if a else "") + " ".join(md[a:b].split()) + ("…" if b < len(md) else ""))
        covered_until = b
        if len(out) >= limit:
            break
    return out


def link_mentions(md: str, page: WikiPage) -> str:
    """링크 안 된 언급을 [[제목]] (다른 표기면 [[제목|원래 표기]]) 로 바꾼다."""
    spans = find_mentions(md, page_names(page))
    out, last = [], 0
    for start, end, text in spans:
        out.append(md[last:start])
        out.append(f"[[{page.title}]]" if norm_title(text) == norm_title(page.title) else f"[[{page.title}|{text}]]")
        last = end
    out.append(md[last:])
    return "".join(out)
