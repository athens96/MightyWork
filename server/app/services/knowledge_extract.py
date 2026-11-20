"""고정 스키마 엔티티·관계 자동 추출기 → 리뷰 큐(pending)에 적재.

외부 LLM API 없이도 위키·일감·용어집에서 결정적 규칙으로 후보 엔티티와 관계를 추출한다:
- 용어집 항목 → 개념(또는 키워드 기반 스키마 타입) 엔티티
- 위키 페이지 → page_type 및 제목/내용 단서로 스키마 타입 추론 (system/service/api/data/role/decision/concept)
- 본문 속 REST API 패턴 (`GET /api/...`), `[[위키 링크]]` 및 문장 내 관계 동사 단서로 관계 후보 생성
- 이미 승인·대기·거절된 엔티티/관계는 중복 생성하지 않는다
"""

import re

from app.db import Database
from app.models.knowledge import (
    EntityKind,
    ExtractResult,
    KnowledgeEntity,
    KnowledgeRelation,
    RelationKind,
    SourceRef,
)
from app.models.project import Project
from app.models.wiki import PageType, WikiPage
from app.services.links import link_targets, norm_title, project_pages

_API_ENDPOINT = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_./{}:-]+)")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。\n])\s+|\n+")

_KIND_CUES: tuple[tuple[EntityKind, tuple[str, ...]], ...] = (
    (EntityKind.API, ("api", "엔드포인트", "endpoint", "webhook", "rest", "graphql", "mcp")),
    (EntityKind.DECISION, ("결정", "adr", "의사결정", "선택", "decision", "합의")),
    (EntityKind.DATA, ("db", "데이터", "테이블", "스키마", "모델", "저장소", "sqlite", "postgres", "redis", "json")),
    (EntityKind.ROLE, ("역할", "권한", "소유자", "관리자", "담당자", "팀", "role", "admin", "rbac")),
    (EntityKind.SERVICE, ("서비스", "모듈", "엔진", "서버", "워커", "게이트웨이", "service", "server", "auth", "oauth")),
    (EntityKind.SYSTEM, ("시스템", "플랫폼", "아키텍처", "인프라", "파이프라인", "system", "platform")),
)

_RELATION_CUES: tuple[tuple[RelationKind, tuple[str, ...]], ...] = (
    (RelationKind.DEPENDS_ON, ("의존", "기반", "필요", "전제", "depends on", "requires", "backed by")),
    (RelationKind.IMPLEMENTS, ("구현", "제공", "처리", "수행", "implements", "provides")),
    (RelationKind.PRODUCES, ("생성", "발급", "출력", "기록", "저장", "만든", "produces", "creates", "generates")),
    (RelationKind.OWNS, ("담당", "소유", "관리", "운영", "owns", "manages")),
    (RelationKind.DECIDES, ("결정", "채택", "선정", "확정", "decides", "chosen")),
    (RelationKind.USES, ("사용", "호출", "연동", "활용", "연결", "통해", "uses", "calls", "integrates")),
)


def infer_entity_kind(name: str, text: str = "", page_type: PageType | None = None) -> EntityKind:
    if page_type == PageType.DECISION:
        return EntityKind.DECISION
    title_cf = name.casefold()
    for kind, cues in _KIND_CUES:
        if any(c in title_cf for c in cues):
            return kind
    if page_type == PageType.SPEC:
        return EntityKind.SERVICE
    sample = text[:400].casefold()
    for kind, cues in _KIND_CUES:
        if any(c in sample for c in cues):
            return kind
    return EntityKind.CONCEPT


def infer_relation_kind(sentence: str) -> RelationKind:
    s = sentence.casefold()
    for kind, cues in _RELATION_CUES:
        if any(c in s for c in cues):
            return kind
    return RelationKind.RELATES_TO


def _first_excerpt(text: str, limit: int = 160) -> str:
    clean = " ".join(re.sub(r"[#>*`]+", " ", text).split())
    return clean[:limit]


def extract_project_knowledge(db: Database, project: Project) -> ExtractResult:
    existing_entities = db.knowledge_entities.list(lambda e: e.project_id == project.id)
    by_name: dict[str, KnowledgeEntity] = {}
    for e in existing_entities:
        by_name[norm_title(e.name)] = e
        for a in e.aliases:
            by_name.setdefault(norm_title(a), e)

    entities_added = 0

    def ensure_entity(
        name: str,
        kind: EntityKind,
        description: str,
        aliases: list[str],
        source: SourceRef,
        confidence: float,
    ) -> KnowledgeEntity:
        nonlocal entities_added
        key = norm_title(name)
        if key in by_name:
            return by_name[key]
        ent = db.knowledge_entities.create(
            KnowledgeEntity(
                project_id=project.id,
                name=name.strip()[:160],
                kind=kind,
                description=description[:2000],
                aliases=aliases[:20],
                status="pending",
                confidence=confidence,
                sources=[source],
            )
        )
        by_name[key] = ent
        for a in ent.aliases:
            by_name.setdefault(norm_title(a), ent)
        entities_added += 1
        return ent

    # 1) 용어집 → 엔티티 후보
    for term in db.glossary_terms.list(lambda g: g.project_id == project.id):
        kind = infer_entity_kind(term.term, term.definition)
        ensure_entity(
            term.term,
            kind,
            term.definition,
            list(term.synonyms),
            SourceRef(source_type="glossary", source_id=term.id, title=term.term, excerpt=term.definition[:160]),
            0.9,
        )

    # 2) 위키 페이지 → 엔티티 후보 + 본문 속 API 엔드포인트 후보
    pages: list[WikiPage] = project_pages(db, project)
    page_entity: dict[str, KnowledgeEntity] = {}
    for p in pages:
        kind = infer_entity_kind(p.title, p.content, p.page_type)
        ent = ensure_entity(
            p.title,
            kind,
            _first_excerpt(p.content, 300),
            list(p.aliases),
            SourceRef(source_type="wiki", source_id=p.id, title=p.title, excerpt=_first_excerpt(p.content)),
            0.85 if p.page_type in (PageType.SPEC, PageType.DECISION, PageType.GUIDE) else 0.72,
        )
        page_entity[p.id] = ent

        for m in _API_ENDPOINT.finditer(p.content):
            ep_name = f"{m.group(1)} {m.group(2)}"
            ensure_entity(
                ep_name,
                EntityKind.API,
                f"'{p.title}' 문서에서 추출된 API 엔드포인트",
                [],
                SourceRef(source_type="wiki", source_id=p.id, title=p.title, excerpt=m.group(0)),
                0.8,
            )

    # 3) 관계 후보 추출 (중복·거절 포함 기존 관계 스킵)
    existing_rels = {
        (r.source_entity_id, r.target_entity_id, r.kind)
        for r in db.knowledge_relations.list(lambda r: r.project_id == project.id)
    }
    relations_added = 0

    def add_relation(
        src: KnowledgeEntity,
        dst: KnowledgeEntity,
        kind: RelationKind,
        evidence: str,
        ref: SourceRef,
        confidence: float,
    ) -> None:
        nonlocal relations_added
        if src.id == dst.id or src.status == "rejected" or dst.status == "rejected":
            return
        key = (src.id, dst.id, kind)
        if key in existing_rels:
            return
        db.knowledge_relations.create(
            KnowledgeRelation(
                project_id=project.id,
                source_entity_id=src.id,
                target_entity_id=dst.id,
                kind=kind,
                evidence=evidence[:500],
                source_ref=ref,
                status="pending",
                confidence=confidence,
            )
        )
        existing_rels.add(key)
        relations_added += 1

    # 3a) 위키 본문의 [[링크]] 및 문장 내 동사 단서 기반 관계
    for p in pages:
        src_ent = page_entity.get(p.id)
        if src_ent is None:
            continue
        ref = SourceRef(source_type="wiki", source_id=p.id, title=p.title, excerpt=_first_excerpt(p.content))
        # 문장 단위로 링크가 들어있는 문장에서 관계 단서 추출
        linked_targets: dict[str, tuple[RelationKind, str]] = {}
        for sent in _SENTENCE_SPLIT.split(p.content):
            targets = link_targets(sent)
            if not targets:
                continue
            rkind = infer_relation_kind(sent)
            snippet = " ".join(sent.split())[:240]
            for t in targets:
                tkey = norm_title(t)
                if tkey not in linked_targets or linked_targets[tkey][0] == RelationKind.RELATES_TO:
                    linked_targets[tkey] = (rkind, snippet)
        for tkey, (rkind, snippet) in linked_targets.items():
            if (dst_ent := by_name.get(tkey)) is not None:
                add_relation(src_ent, dst_ent, rkind, snippet, ref, 0.8 if rkind != RelationKind.RELATES_TO else 0.65)

        # 본문 속 API 엔드포인트 연결
        for m in _API_ENDPOINT.finditer(p.content):
            ep_key = norm_title(f"{m.group(1)} {m.group(2)}")
            if (ep_ent := by_name.get(ep_key)) is not None:
                add_relation(src_ent, ep_ent, RelationKind.IMPLEMENTS, f"'{p.title}' 문서에 정의됨: {m.group(0)}", ref, 0.78)

    # 3b) 일감 설명에서 두 엔티티가 함께 언급된 경우 관계 후보 추출
    active_entities = [e for e in db.knowledge_entities.list(lambda e: e.project_id == project.id) if e.status != "rejected"]
    for task in db.tasks.list(lambda t: t.project_id == project.id):
        if not task.description.strip():
            continue
        t_ref = SourceRef(source_type="task", source_id=task.id, title=f"{project.key}-{task.number} {task.title}", excerpt=_first_excerpt(task.description))
        for sent in _SENTENCE_SPLIT.split(task.description):
            sent_cf = sent.casefold()
            matched = [e for e in active_entities if len(e.name) >= 2 and e.name.casefold() in sent_cf]
            if len(matched) >= 2:
                rkind = infer_relation_kind(sent)
                add_relation(matched[0], matched[1], rkind, " ".join(sent.split())[:240], t_ref, 0.62)

    pending_entities = len(db.knowledge_entities.list(lambda e: e.project_id == project.id and e.status == "pending"))
    pending_relations = len(db.knowledge_relations.list(lambda r: r.project_id == project.id and r.status == "pending"))
    return ExtractResult(
        entities_added=entities_added,
        relations_added=relations_added,
        pending_entities=pending_entities,
        pending_relations=pending_relations,
    )
