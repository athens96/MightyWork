"""프로젝트 위키 전체 ZIP — 페이지 트리를 폴더로, 각 페이지는 front matter 가 붙은 .md (옵시디언 볼트로 열림) + 전체 HTML."""

import io
import zipfile

from app.db import Database
from app.models.project import Project
from app.services.export.html import render_html
from app.services.export.markdown import front_matter
from app.services.export.prepare import PageBlock, collect, safe_filename
from app.services.links import project_pages


def build_zip(db: Database, project: Project) -> bytes:
    pages = sorted(project_pages(db, project), key=lambda p: p.created_at)
    by_id = {p.id: p for p in pages}
    buf = io.BytesIO()
    used: set[str] = set()

    def path_of(p) -> str:
        parts, cur, seen = [], p, set()
        while cur.parent_id and cur.parent_id in by_id and cur.parent_id not in seen:
            seen.add(cur.parent_id)
            cur = by_id[cur.parent_id]
            parts.insert(0, safe_filename(cur.title, "")[:-1])
        return "/".join(["wiki", *parts])

    all_blocks: list[PageBlock] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in pages:
            name = f"{path_of(p)}/{safe_filename(p.title, 'md')}"
            if name in used:  # 같은 제목 충돌
                name = name[:-3] + f"-{p.id[:6]}.md"
            used.add(name)
            z.writestr(name, front_matter(p, db) + f"\n# {p.title}\n\n{p.content}\n")
        roots = [p for p in pages if not p.parent_id or p.parent_id not in by_id]
        for r in roots:
            all_blocks.extend(collect(db, project, r, include_children=True))
        if all_blocks:
            z.writestr("wiki.html", render_html(db, project, all_blocks))
    return buf.getvalue()
