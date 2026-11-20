"""지식화 2~3단계 + 전체 그래프 API:
- 프로젝트 전체 그래프 (GET /projects/{pid}/graph)
- 프로젝트 용어집 (동의어 · 상하위 · 사용처)
- 고정 스키마 엔티티/관계 자동 추출 및 리뷰 큐 (pending / approved / rejected)
- 그래프 기반 Q&A (POST /projects/{pid}/knowledge/qa)
"""

from fastapi import APIRouter, HTTPException, Query, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, apply_patch, require
from app.db import Database
from app.models.common import utcnow
from app.models.knowledge import (
    EntityKind,
    ExtractResult,
    GlossaryTerm,
    GlossaryTermCreate,
    GlossaryTermUpdate,
    GlossaryUsage,
    KnowledgeEntity,
    KnowledgeEntityCreate,
    KnowledgeEntityUpdate,
    KnowledgeRelation,
    KnowledgeRelationCreate,
    KnowledgeRelationUpdate,
    QARequest,
    QAResponse,
    ReviewStatus,
)
from app.models.member import Permission
from app.models.project import Project
from app.services.audit import record_audit
from app.services.graph import ProjectGraph, full_project_graph
from app.services.knowledge_extract import extract_project_knowledge
from app.services.knowledge_qa import answer_question
from app.services.links import find_mentions, mention_snippets, norm_title, project_pages

router = APIRouter(prefix="/projects/{project_id}", tags=["knowledge-base"])


# ---------------------------------------------------------------- 전체 그래프


@router.get("/graph", response_model=ProjectGraph)
def get_project_graph(
    project: ProjectDep,
    db: DbDep,
    include_knowledge: bool = True,
    max_nodes: int = Query(250, ge=10, le=500),
) -> ProjectGraph:
    return full_project_graph(db, project, include_knowledge=include_knowledge, max_nodes=max_nodes)


# ---------------------------------------------------------------- 프로젝트 용어집


def _get_term_or_404(db: Database, project: Project, term_id: str) -> GlossaryTerm:
    term = db.glossary_terms.get(term_id)
    if term is None or term.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Glossary term not found")
    return term


def _validate_broader(db: Database, project: Project, term_id: str | None, broader_id: str | None) -> None:
    current = broader_id
    while current is not None:
        if current == term_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Glossary term cannot be broader than itself")
        parent = db.glossary_terms.get(current)
        if parent is None or parent.project_id != project.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Broader glossary term not found")
        current = parent.broader_id


def _validate_wiki_ref(db: Database, project: Project, wiki_page_id: str | None) -> None:
    if wiki_page_id is not None:
        p = db.wiki_pages.get(wiki_page_id)
        if p is None or p.project_id != project.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Wiki page not found")


@router.get("/glossary", response_model=list[GlossaryTerm])
def list_glossary(project: ProjectDep, db: DbDep, q: str | None = None) -> list[GlossaryTerm]:
    terms = db.glossary_terms.list(lambda g: g.project_id == project.id)
    if q and q.strip():
        needle = q.strip().casefold()
        terms = [
            g
            for g in terms
            if needle in g.term.casefold()
            or needle in g.definition.casefold()
            or any(needle in s.casefold() for s in g.synonyms)
        ]
    return sorted(terms, key=lambda g: g.term.casefold())


@router.post("/glossary", response_model=GlossaryTerm, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_glossary_term(project: ProjectDep, body: GlossaryTermCreate, user: CurrentUser, db: DbDep) -> GlossaryTerm:
    _validate_broader(db, project, None, body.broader_id)
    _validate_wiki_ref(db, project, body.wiki_page_id)
    if any(norm_title(g.term) == norm_title(body.term) for g in db.glossary_terms.list(lambda g: g.project_id == project.id)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Glossary term '{body.term}' already exists")
    term = db.glossary_terms.create(
        GlossaryTerm(**body.model_dump(), project_id=project.id, created_by=user.id, updated_by=user.id)
    )
    return term


@router.patch("/glossary/{term_id}", response_model=GlossaryTerm, dependencies=[require(Permission.EDIT)])
def update_glossary_term(project: ProjectDep, term_id: str, body: GlossaryTermUpdate, user: CurrentUser, db: DbDep) -> GlossaryTerm:
    term = _get_term_or_404(db, project, term_id)
    if "broader_id" in body.model_fields_set:
        _validate_broader(db, project, term.id, body.broader_id)
    if "wiki_page_id" in body.model_fields_set:
        _validate_wiki_ref(db, project, body.wiki_page_id)
    if body.term is not None and norm_title(body.term) != norm_title(term.term):
        if any(g.id != term.id and norm_title(g.term) == norm_title(body.term) for g in db.glossary_terms.list(lambda g: g.project_id == project.id)):
            raise HTTPException(status.HTTP_409_CONFLICT, f"Glossary term '{body.term}' already exists")
    updated = apply_patch(term, body, updated_by=user.id)
    db.glossary_terms.update(updated)
    return updated


@router.delete("/glossary/{term_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_glossary_term(project: ProjectDep, term_id: str, db: DbDep) -> Response:
    _get_term_or_404(db, project, term_id)
    for child in db.glossary_terms.list(lambda g: g.project_id == project.id and g.broader_id == term_id):
        db.glossary_terms.update(child.model_copy(update={"broader_id": None}))
    db.glossary_terms.delete(term_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/glossary/{term_id}/usages", response_model=list[GlossaryUsage])
def glossary_usages(project: ProjectDep, term_id: str, db: DbDep) -> list[GlossaryUsage]:
    term = _get_term_or_404(db, project, term_id)
    names = [term.term, *term.synonyms]
    out: list[GlossaryUsage] = []
    for p in project_pages(db, project):
        spans = find_mentions(p.content, names)
        if spans:
            out.append(GlossaryUsage(source_type="wiki", source_id=p.id, title=p.title, count=len(spans), snippets=mention_snippets(p.content, spans)))
    for t in db.tasks.list(lambda t: t.project_id == project.id):
        text = f"{t.title}\n{t.description}"
        spans = find_mentions(text, names)
        if spans:
            out.append(GlossaryUsage(source_type="task", source_id=t.id, title=t.title, number=t.number, count=len(spans), snippets=mention_snippets(text, spans)))
    return sorted(out, key=lambda u: -u.count)


# ---------------------------------------------------------------- 고정 스키마 엔티티/관계 추출 · 리뷰 큐


@router.post("/knowledge/extract", response_model=ExtractResult, dependencies=[require(Permission.EDIT)])
def run_extraction(project: ProjectDep, user: CurrentUser, db: DbDep) -> ExtractResult:
    result = extract_project_knowledge(db, project)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="knowledge.extracted",
        target_type="knowledge",
        target_id=project.id,
        summary=f"지식 추출: 엔티티 +{result.entities_added}, 관계 +{result.relations_added}",
        details=result.model_dump(),
    )
    return result


@router.get("/knowledge/entities", response_model=list[KnowledgeEntity])
def list_entities(
    project: ProjectDep,
    db: DbDep,
    review_status: ReviewStatus | None = Query(None, alias="status"),
    kind: EntityKind | None = None,
) -> list[KnowledgeEntity]:
    items = db.knowledge_entities.list(
        lambda e: e.project_id == project.id
        and (review_status is None or e.status == review_status)
        and (kind is None or e.kind == kind)
    )
    return sorted(items, key=lambda e: (e.status != "pending", -e.confidence, e.name.casefold()))


@router.post("/knowledge/entities", response_model=KnowledgeEntity, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_entity(project: ProjectDep, body: KnowledgeEntityCreate, user: CurrentUser, db: DbDep) -> KnowledgeEntity:
    if any(norm_title(e.name) == norm_title(body.name) for e in db.knowledge_entities.list(lambda e: e.project_id == project.id)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Entity '{body.name}' already exists")
    now = utcnow()
    return db.knowledge_entities.create(
        KnowledgeEntity(
            **body.model_dump(),
            project_id=project.id,
            confidence=1.0,
            reviewed_by=user.id if body.status != "pending" else None,
            reviewed_at=now if body.status != "pending" else None,
        )
    )


@router.patch("/knowledge/entities/{entity_id}", response_model=KnowledgeEntity, dependencies=[require(Permission.EDIT)])
def update_entity(project: ProjectDep, entity_id: str, body: KnowledgeEntityUpdate, user: CurrentUser, db: DbDep) -> KnowledgeEntity:
    ent = db.knowledge_entities.get(entity_id)
    if ent is None or ent.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Entity not found")
    extra = {}
    if body.status is not None and body.status != ent.status:
        extra = {"reviewed_by": user.id, "reviewed_at": utcnow()}
    updated = apply_patch(ent, body, **extra)
    db.knowledge_entities.update(updated)
    if extra:
        record_audit(
            db,
            project_id=project.id,
            actor_id=user.id,
            action="knowledge.reviewed",
            target_type="knowledge",
            target_id=ent.id,
            summary=f"엔티티 '{updated.name}' → {updated.status}",
        )
    return updated


@router.delete("/knowledge/entities/{entity_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_entity(project: ProjectDep, entity_id: str, db: DbDep) -> Response:
    ent = db.knowledge_entities.get(entity_id)
    if ent is None or ent.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Entity not found")
    for rel in db.knowledge_relations.list(lambda r: r.source_entity_id == entity_id or r.target_entity_id == entity_id):
        db.knowledge_relations.delete(rel.id)
    db.knowledge_entities.delete(entity_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/knowledge/relations", response_model=list[KnowledgeRelation])
def list_relations(
    project: ProjectDep,
    db: DbDep,
    review_status: ReviewStatus | None = Query(None, alias="status"),
) -> list[KnowledgeRelation]:
    items = db.knowledge_relations.list(
        lambda r: r.project_id == project.id and (review_status is None or r.status == review_status)
    )
    return sorted(items, key=lambda r: (r.status != "pending", -r.confidence, r.created_at))


@router.post("/knowledge/relations", response_model=KnowledgeRelation, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_relation(project: ProjectDep, body: KnowledgeRelationCreate, user: CurrentUser, db: DbDep) -> KnowledgeRelation:
    if body.source_entity_id == body.target_entity_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot relate an entity to itself")
    src = db.knowledge_entities.get(body.source_entity_id)
    dst = db.knowledge_entities.get(body.target_entity_id)
    if src is None or src.project_id != project.id or dst is None or dst.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Entity not found")
    now = utcnow()
    return db.knowledge_relations.create(
        KnowledgeRelation(
            **body.model_dump(),
            project_id=project.id,
            confidence=1.0,
            reviewed_by=user.id if body.status != "pending" else None,
            reviewed_at=now if body.status != "pending" else None,
        )
    )


@router.patch("/knowledge/relations/{relation_id}", response_model=KnowledgeRelation, dependencies=[require(Permission.EDIT)])
def update_relation(project: ProjectDep, relation_id: str, body: KnowledgeRelationUpdate, user: CurrentUser, db: DbDep) -> KnowledgeRelation:
    rel = db.knowledge_relations.get(relation_id)
    if rel is None or rel.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Relation not found")
    extra = {}
    if body.status is not None and body.status != rel.status:
        extra = {"reviewed_by": user.id, "reviewed_at": utcnow()}
    updated = apply_patch(rel, body, **extra)
    db.knowledge_relations.update(updated)
    if extra:
        record_audit(
            db,
            project_id=project.id,
            actor_id=user.id,
            action="knowledge.reviewed",
            target_type="knowledge",
            target_id=rel.id,
            summary=f"관계({updated.kind.value}) → {updated.status}",
        )
    return updated


@router.delete("/knowledge/relations/{relation_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_relation(project: ProjectDep, relation_id: str, db: DbDep) -> Response:
    rel = db.knowledge_relations.get(relation_id)
    if rel is None or rel.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Relation not found")
    db.knowledge_relations.delete(relation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- 그래프 기반 Q&A


@router.post("/knowledge/qa", response_model=QAResponse)
def knowledge_qa(project: ProjectDep, body: QARequest, db: DbDep) -> QAResponse:
    return answer_question(db, project, body.question)
