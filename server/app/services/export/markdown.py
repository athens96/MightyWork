"""Markdown 내보내기 — [[링크]]·일감 키 원문 유지 (옵시디언 등에서 그대로 열림), 속성은 YAML front matter."""

import json

from app.db import Database
from app.models.project import Project
from app.models.wiki import WikiPage
from app.services.export.prepare import PageBlock, shift_headings


def front_matter(page: WikiPage, db: Database) -> str:
    owner = db.users.get(page.owner_id) if page.owner_id else None
    fields: dict[str, object] = {"title": page.title}
    if page.aliases:
        fields["aliases"] = page.aliases
    if page.tags:
        fields["tags"] = page.tags
    if page.page_type:
        fields["type"] = page.page_type.value
    if page.status:
        fields["status"] = page.status.value
    if owner:
        fields["owner"] = owner.email
    fields["updated"] = page.updated_at.isoformat(timespec="seconds")
    # YAML 은 JSON 의 상위 집합 — 값은 JSON 으로 써서 따옴표·특수문자 걱정을 없앤다
    lines = [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in fields.items()]
    return "---\n" + "\n".join(lines) + "\n---\n"


def render_markdown(db: Database, project: Project, blocks: list[PageBlock]) -> str:
    if len(blocks) == 1:
        p = blocks[0].page
        return front_matter(p, db) + f"\n# {p.title}\n\n{p.content}\n"
    parts = [front_matter(blocks[0].page, db)]
    for b in blocks:
        hashes = "#" * min(b.depth + 1, 6)
        parts.append(f"\n{hashes} {b.page.title}\n\n{shift_headings(b.page.content, b.depth + 1)}\n")
    return "".join(parts)
