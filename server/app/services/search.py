"""프로젝트 단위 전문 검색 (일감 + 위키). 부분 문자열 매칭 + 간단한 점수.
SQLite 로 옮기면 FTS5 로 교체할 자리."""

import re
from typing import Literal

from pydantic import BaseModel

from app.db import Database
from app.models.project import Project

_MD_NOISE = re.compile(r"[#>*_`~\[\]|]+")


class SearchHit(BaseModel):
    kind: Literal["task", "wiki"]
    id: str
    title: str
    snippet: str  # 일치 부분 주변 텍스트 (마크다운 기호 제거)
    score: float
    number: int | None = None  # 일감 번호
    stage: str | None = None  # 일감 단계


_WIKI_LINK = re.compile(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]")


def _snippet(text: str, q: str, width: int = 70) -> str:
    text = _WIKI_LINK.sub(lambda m: (m.group(2) or m.group(1)).strip(), text)  # [[대상|별칭]] → 별칭
    plain = " ".join(_MD_NOISE.sub(" ", text).split())
    i = plain.casefold().find(q)
    if i < 0:
        return plain[: width * 2]
    start = max(0, i - width)
    return ("…" if start else "") + plain[start : i + len(q) + width] + ("…" if i + len(q) + width < len(plain) else "")


def search(db: Database, project: Project, query: str, limit: int = 30) -> list[SearchHit]:
    q = " ".join(query.split()).casefold()
    if not q:
        return []
    hits: list[SearchHit] = []

    key_match = re.fullmatch(rf"{re.escape(project.key.casefold())}-(\d+)", q)
    candidates = db.search_candidates(project.id, q)

    if candidates is not None:
        task_ids, wiki_ids = candidates
        if key_match:
            target_num = int(key_match.group(1))
            for t in db.tasks.list(lambda t: t.project_id == project.id and t.number == target_num):
                task_ids.add(t.id)
        tasks = [t for tid in task_ids if (t := db.tasks.get(tid)) is not None and t.project_id == project.id]
        pages = [p for pid in wiki_ids if (p := db.wiki_pages.get(pid)) is not None and p.project_id == project.id]
        comments_by_task: dict[str, list[str]] = {}
        if task_ids:
            for c in db.comments.list(lambda c: c.project_id == project.id and c.task_id in task_ids):
                comments_by_task.setdefault(c.task_id, []).append(c.body)
    else:
        tasks = db.tasks.list(lambda t: t.project_id == project.id)
        pages = db.wiki_pages.list(lambda p: p.project_id == project.id)
        comments_by_task = {}
        for c in db.comments.list(lambda c: c.project_id == project.id):
            comments_by_task.setdefault(c.task_id, []).append(c.body)

    for t in tasks:
        if key_match and int(key_match.group(1)) == t.number:
            score, body = 100.0, t.description  # 키로 정확히 찾으면 맨 위
        else:
            score, body = 0.0, ""
            if q in t.title.casefold():
                score += 10
            if t.version and q in t.version.casefold():
                score += 6
            if any(q in tag.casefold() for tag in t.tags):
                score += 5
            parts = [t.description, *(i.text for i in t.checklist), *comments_by_task.get(t.id, [])]
            matched = [p for p in parts if q in p.casefold()]
            if matched:
                score += 2 + min(len(matched), 3)
                body = matched[0]
            if score == 0:
                continue
        hits.append(SearchHit(kind="task", id=t.id, title=t.title, snippet=_snippet(body or t.description, q),
                              score=score, number=t.number, stage=t.stage.value))

    for p in pages:
        score = 10.0 if q in p.title.casefold() else 8.0 if any(q in a.casefold() for a in p.aliases) else 0.0
        if any(q in t.casefold() for t in p.tags):
            score += 5
        count = p.content.casefold().count(q)
        score += min(count, 5) + (2 if count else 0)
        if score:
            hits.append(SearchHit(kind="wiki", id=p.id, title=p.title, snippet=_snippet(p.content, q), score=score))

    return sorted(hits, key=lambda h: -h.score)[:limit]
