"""위키 페이지 버전 히스토리: 스냅샷 저장, 줄 단위 Diff 계산, 이전 버전 복원."""

import difflib

from app.db import Database
from app.models.wiki import DiffLine, WikiPage, WikiRevision


def list_revisions(db: Database, page_id: str) -> list[WikiRevision]:
    return sorted(
        db.wiki_revisions.list(lambda r: r.page_id == page_id),
        key=lambda r: r.version,
        reverse=True,
    )


def record_revision(db: Database, page: WikiPage, editor_id: str, note: str = "") -> WikiRevision:
    existing = db.wiki_revisions.list(lambda r: r.page_id == page.id)
    next_ver = max((r.version for r in existing), default=0) + 1
    return db.wiki_revisions.create(
        WikiRevision(
            project_id=page.project_id,
            page_id=page.id,
            version=next_ver,
            title=page.title,
            content=page.content,
            aliases=list(page.aliases),
            page_type=page.page_type,
            status=page.status,
            tags=list(page.tags),
            editor_id=editor_id,
            note=note,
        )
    )


def line_diff(old_text: str, new_text: str) -> list[DiffLine]:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    sm = difflib.SequenceMatcher(None, old_lines, new_lines)
    out: list[DiffLine] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(DiffLine(kind="equal", text=line) for line in old_lines[i1:i2])
        elif tag == "delete":
            out.extend(DiffLine(kind="del", text=line) for line in old_lines[i1:i2])
        elif tag == "insert":
            out.extend(DiffLine(kind="add", text=line) for line in new_lines[j1:j2])
        elif tag == "replace":
            out.extend(DiffLine(kind="del", text=line) for line in old_lines[i1:i2])
            out.extend(DiffLine(kind="add", text=line) for line in new_lines[j1:j2])
    return out
