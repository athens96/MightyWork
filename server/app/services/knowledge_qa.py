"""그래프 기반 Q&A: 용어집 동의어/상하위 확장 → 시드 노드 탐색 → 지식·문서 그래프 1~2홉 순회 → 근거 기반 응답."""

import re

from app.db import Database
from app.models.knowledge import QACitation, QAResponse
from app.models.project import Project
from app.services.graph import full_project_graph
from app.services.links import norm_title, project_pages

_TOKEN = re.compile(r"[가-힣A-Za-z0-9_-]{2,}")
_KO_PARTICLE = re.compile(
    r"(?:이란|란|에서|으로|에게|까지|부터|처럼|보다|은|는|이|가|을|를|의|에|로|와|과|도|만|요)$"
)
_STOPWORDS = {
    "무엇", "무슨", "어떻게", "어디", "언제", "누가", "왜", "알려줘", "알려주세요", "설명해줘", "설명",
    "관련", "있는", "있어", "인가요", "인가", "뭐야", "뭔가요", "대해", "대해서", "정리",
    "what", "how", "why", "where", "when", "who", "is", "are", "the", "for", "and", "with", "about",
}

_REL_KO = {
    "uses": "사용함",
    "depends_on": "의존함",
    "produces": "생성함",
    "owns": "담당함",
    "implements": "구현함",
    "decides": "결정함",
    "relates_to": "관련됨",
}


def _extract_keywords(question: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for m in _TOKEN.finditer(question):
        raw = m.group(0).casefold()
        cleaned = _KO_PARTICLE.sub("", raw) if len(raw) >= 3 else raw
        for cand in (cleaned, raw):
            if len(cand) >= 2 and cand not in _STOPWORDS and cand not in seen:
                seen.add(cand)
                out.append(cand)
    return out


def _snippet_for(text: str, terms: list[str], width: int = 85) -> str:
    plain = " ".join(re.sub(r"[#>*_`\[\]|]+", " ", text).split())
    plain_cf = plain.casefold()
    for t in terms:
        i = plain_cf.find(t)
        if i >= 0:
            start = max(0, i - width)
            end = min(len(plain), i + len(t) + width)
            return ("…" if start else "") + plain[start:end] + ("…" if end < len(plain) else "")
    return plain[: width * 2]


def answer_question(db: Database, project: Project, question: str) -> QAResponse:
    keywords = _extract_keywords(question)
    if not keywords:
        return QAResponse(
            question=question,
            answer="질문에서 핵심 키워드를 찾지 못했습니다. 문서 제목, 용어, 일감 키 등을 포함해 질문해 보세요.",
            expanded_terms=[],
            citations=[],
            related_facts=[],
            graph_nodes=[],
            graph_edges=[],
        )

    terms = db.glossary_terms.list(lambda g: g.project_id == project.id)
    terms_by_id = {g.id: g for g in terms}
    pages = project_pages(db, project)
    tasks = db.tasks.list(lambda t: t.project_id == project.id)
    entities = db.knowledge_entities.list(lambda e: e.project_id == project.id and e.status == "approved")
    relations = db.knowledge_relations.list(lambda r: r.project_id == project.id and r.status == "approved")

    # 1) 용어집 동의어·상하위 + 위키 별칭으로 검색어 확장
    expanded: list[str] = list(keywords)
    seen_terms = set(expanded)

    def add_term(value: str) -> None:
        v = value.strip().casefold()
        if len(v) >= 2 and v not in seen_terms:
            seen_terms.add(v)
            expanded.append(v)

    matched_glossary = []
    for g in terms:
        all_names = [g.term, *g.synonyms]
        if any(k in n.casefold() or n.casefold() in k for k in keywords for n in all_names):
            matched_glossary.append(g)
            for n in all_names:
                add_term(n)
            if g.broader_id and (broader := terms_by_id.get(g.broader_id)):
                add_term(broader.term)
            for child in terms:
                if child.broader_id == g.id:
                    add_term(child.term)

    for p in pages:
        if any(k in a.casefold() for k in keywords for a in p.aliases):
            add_term(p.title)

    # 2) 시드 노드 탐색 & 점수화
    seed_ids: set[str] = set()
    citations: list[tuple[float, QACitation]] = []

    for g in matched_glossary:
        seed_ids.add(f"glossary:{g.id}")
        if g.wiki_page_id:
            seed_ids.add(f"wiki:{g.wiki_page_id}")
        citations.append(
            (
                20.0,
                QACitation(
                    kind="glossary",
                    id=g.id,
                    title=g.term,
                    snippet=g.definition or (f"동의어: {', '.join(g.synonyms)}" if g.synonyms else "용어집 항목"),
                    link=f"/projects/{project.id}/knowledge?tab=glossary",
                ),
            )
        )

    entities_by_id = {e.id: e for e in entities}
    matched_entities = []
    for e in entities:
        names = [e.name, *e.aliases]
        score = sum(8.0 for t in expanded if any(t in n.casefold() for n in names))
        if score == 0 and any(t in e.description.casefold() for t in expanded):
            score = 4.0
        if score > 0:
            matched_entities.append((score, e))
            seed_ids.add(f"entity:{e.id}")
            citations.append(
                (
                    15.0 + score,
                    QACitation(
                        kind="entity",
                        id=e.id,
                        title=f"{e.name} ({e.kind.value})",
                        snippet=e.description or "승인된 지식 엔티티",
                        link=f"/projects/{project.id}/knowledge?tab=review",
                    ),
                )
            )

    for p in pages:
        title_cf, body_cf = p.title.casefold(), p.content.casefold()
        score = 0.0
        for t in expanded:
            if t in title_cf or any(t in a.casefold() for a in p.aliases):
                score += 10.0
            if t in body_cf:
                score += 3.0
        if score > 0:
            seed_ids.add(f"wiki:{p.id}")
            citations.append(
                (
                    score,
                    QACitation(
                        kind="wiki",
                        id=p.id,
                        title=p.title,
                        snippet=_snippet_for(p.content, expanded),
                        link=f"/projects/{project.id}/wiki/{p.id}",
                    ),
                )
            )

    for task in tasks:
        key_str = f"{project.key}-{task.number}".casefold()
        blob = " ".join([key_str, task.title, *task.tags, task.description]).casefold()
        score = 0.0
        for t in expanded:
            if t == key_str:
                score += 25.0
            elif t in task.title.casefold():
                score += 8.0
            elif t in blob:
                score += 3.0
        if score > 0:
            seed_ids.add(f"task:{task.id}")
            citations.append(
                (
                    score,
                    QACitation(
                        kind="task",
                        id=task.id,
                        title=task.title,
                        number=task.number,
                        snippet=_snippet_for(task.description or task.title, expanded),
                        link=f"/projects/{project.id}/tasks/{task.id}",
                    ),
                )
            )

    # 3) 통합 그래프에서 시드 노드의 1홉 이웃 추출
    graph = full_project_graph(db, project, include_knowledge=True, max_nodes=300)
    nodes_by_id = {n.id: n for n in graph.nodes}
    sub_node_ids = set(seed_ids)
    sub_edges = []
    for e in graph.edges:
        if e.source in seed_ids or e.target in seed_ids:
            sub_node_ids.add(e.source)
            sub_node_ids.add(e.target)
            sub_edges.append(e)

    # 4) 승인된 지식 관계에서 직접 관련된 사실 수집
    matched_entity_ids = {e.id for _, e in matched_entities}
    related_facts: list[str] = []
    for r in relations:
        if r.source_entity_id in matched_entity_ids or r.target_entity_id in matched_entity_ids:
            s_ent = entities_by_id.get(r.source_entity_id)
            t_ent = entities_by_id.get(r.target_entity_id)
            if s_ent and t_ent:
                rel_ko = _REL_KO.get(r.kind.value, r.kind.value)
                ev = f" — {r.evidence}" if r.evidence else ""
                related_facts.append(f"{s_ent.name} → [{rel_ko}] → {t_ent.name}{ev}")

    # 용어집 상하위 관계 사실 추가
    for g in matched_glossary:
        if g.broader_id and (broader := terms_by_id.get(g.broader_id)):
            related_facts.append(f"용어 '{g.term}' 의 상위 개념은 '{broader.term}' 입니다.")
        narrower = [c.term for c in terms if c.broader_id == g.id]
        if narrower:
            related_facts.append(f"용어 '{g.term}' 의 하위 개념: {', '.join(narrower)}")

    # 5) 근거 기반 한국어 답변 조합
    top_citations = [c for _, c in sorted(citations, key=lambda x: -x[0])[:8]]
    sections: list[str] = []
    if matched_glossary:
        defs = [f"- **{g.term}**: {g.definition or '정의 미입력'}" + (f" (동의어: {', '.join(g.synonyms)})" if g.synonyms else "") for g in matched_glossary[:3]]
        sections.append("### 용어 정의\n" + "\n".join(defs))
    if related_facts:
        sections.append("### 지식 그래프 관계\n" + "\n".join(f"- {f}" for f in related_facts[:6]))
    doc_cites = [c for c in top_citations if c.kind in ("wiki", "task")]
    if doc_cites:
        lines = [
            f"- **{c.title}**" + (f" ({project.key}-{c.number})" if c.number else "") + (f": {c.snippet}" if c.snippet else "")
            for c in doc_cites[:4]
        ]
        sections.append("### 관련 문서 · 일감 근거\n" + "\n".join(lines))

    if not sections:
        answer = f"'{question}' 와 직접 일치하는 용어·엔티티·문서를 찾지 못했습니다. 위키 문서를 작성하거나 지식 추출을 실행해 보세요."
    else:
        answer = "\n\n".join(sections)

    sub_nodes = [nodes_by_id[nid].model_dump() for nid in sub_node_ids if nid in nodes_by_id][:40]
    kept = {n["id"] for n in sub_nodes}
    out_edges = [e.model_dump() for e in sub_edges if e.source in kept and e.target in kept][:60]

    return QAResponse(
        question=question,
        answer=answer,
        expanded_terms=expanded[:15],
        citations=top_citations,
        related_facts=related_facts[:10],
        graph_nodes=sub_nodes,
        graph_edges=out_edges,
    )
