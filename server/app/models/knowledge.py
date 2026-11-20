"""지식화 2~3단계 모델: 프로젝트 용어집, 고정 스키마 엔티티/관계(리뷰 큐), 그래프 Q&A."""

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from app.models.common import Entity
from app.models.wiki import Aliases


class GlossaryTerm(Entity):
    """프로젝트 용어집 항목 (동의어 + 상하위 개념)."""

    project_id: str
    term: str = Field(min_length=1, max_length=120)
    definition: str = Field(default="", max_length=2000)
    synonyms: Aliases = []
    broader_id: str | None = None  # 상위 용어 id
    wiki_page_id: str | None = None  # 연결 위키 페이지
    created_by: str
    updated_by: str


class GlossaryTermCreate(BaseModel):
    term: str = Field(min_length=1, max_length=120)
    definition: str = Field(default="", max_length=2000)
    synonyms: Aliases = []
    broader_id: str | None = None
    wiki_page_id: str | None = None


class GlossaryTermUpdate(BaseModel):
    term: str | None = Field(default=None, min_length=1, max_length=120)
    definition: str | None = Field(default=None, max_length=2000)
    synonyms: Aliases | None = None
    broader_id: str | None = None
    wiki_page_id: str | None = None


class GlossaryUsage(BaseModel):
    source_type: Literal["wiki", "task"]
    source_id: str
    title: str
    number: int | None = None
    count: int
    snippets: list[str]


# ---------------------------------------------------------------- 고정 스키마 엔티티 · 관계 (리뷰 큐)


class EntityKind(str, Enum):
    SYSTEM = "system"  # 시스템
    SERVICE = "service"  # 서비스/모듈
    API = "api"  # API/엔드포인트
    DATA = "data"  # 데이터/테이블/모델
    ROLE = "role"  # 역할/팀
    DECISION = "decision"  # 의사결정
    CONCEPT = "concept"  # 도메인 개념


class RelationKind(str, Enum):
    USES = "uses"  # 사용
    DEPENDS_ON = "depends_on"  # 의존
    PRODUCES = "produces"  # 생성/출력
    OWNS = "owns"  # 담당/소유
    IMPLEMENTS = "implements"  # 구현
    DECIDES = "decides"  # 결정
    RELATES_TO = "relates_to"  # 관련


ReviewStatus = Literal["pending", "approved", "rejected"]


class SourceRef(BaseModel):
    source_type: Literal["wiki", "task", "glossary"]
    source_id: str
    title: str = ""
    excerpt: str = ""


class KnowledgeEntity(Entity):
    project_id: str
    name: str = Field(min_length=1, max_length=160)
    kind: EntityKind
    description: str = Field(default="", max_length=2000)
    aliases: Aliases = []
    status: ReviewStatus = "pending"
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    sources: list[SourceRef] = []
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None


class KnowledgeEntityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    kind: EntityKind
    description: str = Field(default="", max_length=2000)
    aliases: Aliases = []
    status: ReviewStatus = "approved"  # 수동 추가는 기본 승인 (리뷰 큐로 보내려면 pending)


class KnowledgeEntityUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    kind: EntityKind | None = None
    description: str | None = Field(default=None, max_length=2000)
    aliases: Aliases | None = None
    status: ReviewStatus | None = None


class KnowledgeRelation(Entity):
    project_id: str
    source_entity_id: str
    target_entity_id: str
    kind: RelationKind
    evidence: str = Field(default="", max_length=500)
    source_ref: SourceRef | None = None
    status: ReviewStatus = "pending"
    confidence: float = Field(default=0.65, ge=0.0, le=1.0)
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None


class KnowledgeRelationCreate(BaseModel):
    source_entity_id: str
    target_entity_id: str
    kind: RelationKind
    evidence: str = Field(default="", max_length=500)
    status: ReviewStatus = "approved"


class KnowledgeRelationUpdate(BaseModel):
    kind: RelationKind | None = None
    evidence: str | None = Field(default=None, max_length=500)
    status: ReviewStatus | None = None


class ExtractResult(BaseModel):
    entities_added: int
    relations_added: int
    pending_entities: int
    pending_relations: int


# ---------------------------------------------------------------- 그래프 기반 Q&A


class QARequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class QACitation(BaseModel):
    kind: Literal["wiki", "task", "glossary", "entity"]
    id: str
    title: str
    snippet: str
    number: int | None = None
    link: str = ""


class QAResponse(BaseModel):
    question: str
    answer: str
    expanded_terms: list[str]
    citations: list[QACitation]
    related_facts: list[str]
    graph_nodes: list[dict]
    graph_edges: list[dict]
