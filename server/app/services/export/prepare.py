"""내보내기용 문서 묶음 준비 — 형식과 무관한 공통 단계.

- 하위 페이지 포함 시 트리 순서(DFS, 만든 순)로 펼치고 단계만큼 제목 수준을 내린다
- 페이지마다 속성 요약(별칭·타입·상태·담당자·태그·수정일)
- [[링크]] 처리는 형식별로 다르다: md 는 원문 유지(옵시디언 호환), 나머지는 표시 텍스트로 풀거나 문서 내 링크로
"""

import re
from dataclasses import dataclass
from datetime import datetime

from app.db import Database
from app.models.project import Project
from app.models.wiki import WikiPage
from app.services.links import WIKI_LINK, norm_title, pages_by_title, project_pages

TYPE_LABEL = {"guide": "가이드", "spec": "명세", "decision": "결정", "meeting": "회의록", "reference": "참고", "note": "메모"}
STATUS_LABEL = {"draft": "초안", "review": "검토 중", "published": "확정", "deprecated": "폐기"}

_FENCE = re.compile(r"^\s{0,3}(```|~~~)")
_HEADING = re.compile(r"^(\s{0,3})(#{1,6})(\s)")


@dataclass
class PageBlock:
    page: WikiPage
    depth: int  # 0 = 내보내기 시작 페이지
    meta: list[tuple[str, str]]  # (이름, 값) — 표지 줄

    @property
    def anchor(self) -> str:
        return f"page-{self.page.id}"


def collect(db: Database, project: Project, root: WikiPage, include_children: bool) -> list[PageBlock]:
    pages = project_pages(db, project)
    users = {u.id: u for u in db.users.list()}
    children: dict[str | None, list[WikiPage]] = {}
    for p in sorted(pages, key=lambda p: p.created_at):
        children.setdefault(p.parent_id, []).append(p)

    out: list[PageBlock] = []

    def walk(p: WikiPage, depth: int) -> None:
        out.append(PageBlock(page=p, depth=depth, meta=_meta(p, users)))
        if include_children:
            for c in children.get(p.id, []):
                walk(c, depth + 1)

    walk(root, 0)
    return out


def _meta(p: WikiPage, users: dict) -> list[tuple[str, str]]:
    meta = []
    if p.aliases:
        meta.append(("별칭", ", ".join(p.aliases)))
    if p.page_type:
        meta.append(("타입", TYPE_LABEL[p.page_type.value]))
    if p.status:
        meta.append(("상태", STATUS_LABEL[p.status.value]))
    if p.owner_id and (u := users.get(p.owner_id)):
        meta.append(("담당자", u.name or u.email))
    if p.tags:
        meta.append(("태그", " ".join(f"#{t}" for t in p.tags)))
    meta.append(("수정", _date(p.updated_at)))
    return meta


def _date(dt: datetime) -> str:
    return dt.astimezone().strftime("%Y-%m-%d")


def shift_headings(md: str, by: int) -> str:
    """코드 블록 밖의 ATX 제목(#)을 by 단계 내린다 (최대 ######)."""
    if by <= 0:
        return md
    out, in_code = [], False
    for line in md.split("\n"):
        if _FENCE.match(line):
            in_code = not in_code
        elif not in_code and (m := _HEADING.match(line)):
            level = min(len(m.group(2)) + by, 6)
            line = m.group(1) + "#" * level + m.group(3) + line[m.end() :]
        out.append(line)
    return "\n".join(out)


def resolve_links(md: str, db: Database, project: Project, bundle_ids: set[str] | None) -> str:
    """[[대상|표시]] → 묶음 안 문서면 [표시](#page-id), 아니면 표시 텍스트만 (코드 안은 유지)."""
    by_title = pages_by_title(project_pages(db, project))

    def repl(m: re.Match) -> str:
        label = (m.group(2) or m.group(1)).strip()
        target = by_title.get(norm_title(m.group(1)))
        if bundle_ids is not None and target is not None and target.id in bundle_ids:
            return f"[{label}](#page-{target.id})"
        return label

    # 코드 블록·인라인 코드는 건드리지 않도록 조각내서 처리
    parts = re.split(r"(```.*?```|`[^`\n]*`)", md, flags=re.S)
    return "".join(p if i % 2 else WIKI_LINK.sub(repl, p) for i, p in enumerate(parts))


def safe_filename(title: str, ext: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", title).strip()[:80] or "wiki"
    return f"{name}.{ext}"
