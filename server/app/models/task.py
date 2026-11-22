from datetime import date, datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.common import Entity, new_id


class PipelineStage(str, Enum):
    """개발 파이프라인 단계. 순서가 곧 보드의 컬럼 순서."""

    BACKLOG = "backlog"
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    QA = "qa"
    DONE = "done"


PIPELINE_LABELS: dict[PipelineStage, str] = {
    PipelineStage.BACKLOG: "백로그",
    PipelineStage.TODO: "할 일",
    PipelineStage.IN_PROGRESS: "진행 중",
    PipelineStage.REVIEW: "코드 리뷰",
    PipelineStage.QA: "QA",
    PipelineStage.DONE: "완료",
}


class Priority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class ChecklistItem(BaseModel):
    """일감 안의 '할 일' 항목."""

    id: str = Field(default_factory=new_id)
    text: str = Field(min_length=1, max_length=500)
    done: bool = False


class TaskLinkKind(str, Enum):
    """일감 간 관계 (저장 방향 기준)."""

    BLOCKS = "blocks"  # source 가 target 을 차단
    RELATES_TO = "relates_to"  # 관련 일감 (대칭)
    DUPLICATES = "duplicates"  # source 가 target 의 중복


class TaskLink(Entity):
    project_id: str
    source_id: str
    target_id: str
    kind: TaskLinkKind
    created_by: str


class TaskLinkCreate(BaseModel):
    target_id: str
    kind: TaskLinkKind = TaskLinkKind.RELATES_TO


class TaskLinkRead(BaseModel):
    """현재 일감 관점에서 본 연결 정보 (역방향은 blocked_by / duplicated_by 로 표기)."""

    id: str
    kind: str  # blocks | blocked_by | relates_to | duplicates | duplicated_by
    task_id: str
    number: int
    title: str
    stage: PipelineStage


class TaskBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""  # Markdown
    stage: PipelineStage = PipelineStage.BACKLOG
    priority: Priority = Priority.MEDIUM
    parent_id: str | None = None  # 상위 일감 (하위 일감 트리)
    cycle_id: str | None = None  # 소속 사이클(스프린트)
    milestone_id: str | None = None  # 소속 마일스톤(릴리즈/에픽)
    version: str | None = Field(default=None, max_length=40)  # 목표/릴리즈 버전 (예: v0.5.10, v0.6.x)
    assignee_id: str | None = None  # 작업자
    tags: list[str] = []  # 레이블
    start_date: date | None = None  # 시작일
    due_date: date | None = None  # 종료일(마감)
    estimate: int | None = Field(default=None, ge=0, le=100)  # 추정치(스토리 포인트)
    checklist: list[ChecklistItem] = Field(default=[], max_length=200)
    triage_status: Literal["pending", "snoozed", "declined"] | None = None
    triage_snooze_until: date | None = None
    triage_source: str = Field(default="", max_length=120)

    @field_validator("version", mode="before")
    @classmethod
    def _clean_version(cls, v: object) -> object:
        if isinstance(v, str):
            s = v.strip()
            return s or None
        return v

    @model_validator(mode="after")
    def _check_dates(self):
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError("start_date must be on or before due_date")
        return self


class Task(Entity, TaskBase):
    project_id: str
    number: int  # 프로젝트 내 일련번호. 표시용 키는 f"{project.key}-{number}"
    created_by: str
    watcher_ids: list[str] = []  # 일감 구독자(워처) ID 목록
    deleted_at: datetime | None = None  # 휴지통 이동 시각 (None 이면 활성)
    deleted_by: str | None = None
    via_client: str | None = None  # MCP OAuth client_name (예: Claude Code, MightyCode)


class TaskRead(Task):
    """응답용: 저장하지 않는 계산 필드 포함."""

    comment_count: int = 0
    subtask_count: int = 0
    subtask_done: int = 0
    blocked_by_count: int = 0  # 미완료 선행 일감(BLOCKS)에 의해 차단된 건수


class TaskCreate(TaskBase):
    pass


class TaskUpdate(BaseModel):
    """PATCH: 보낸 필드만 반영된다."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    stage: PipelineStage | None = None
    priority: Priority | None = None
    parent_id: str | None = None
    cycle_id: str | None = None
    milestone_id: str | None = None
    version: str | None = Field(default=None, max_length=40)
    assignee_id: str | None = None
    tags: list[str] | None = None
    start_date: date | None = None
    due_date: date | None = None
    estimate: int | None = Field(default=None, ge=0, le=100)
    checklist: list[ChecklistItem] | None = Field(default=None, max_length=200)

    @field_validator("version", mode="before")
    @classmethod
    def _clean_version(cls, v: object) -> object:
        if isinstance(v, str):
            s = v.strip()
            return s or None
        return v


class PipelineStageInfo(BaseModel):
    key: PipelineStage
    label: str = Field(min_length=1, max_length=40)
    color: str = Field(default="", max_length=32)  # 선택적 톤 클래스(예: tone-run)
    hidden: bool = False
    wip_limit: int | None = Field(default=None, ge=1, le=200)


class ProjectPipeline(Entity):
    project_id: str
    stages: list[PipelineStageInfo]


class ProjectPipelineUpdate(BaseModel):
    stages: list[PipelineStageInfo] = Field(min_length=1, max_length=6)
    remap_hidden_to: PipelineStage | None = None


def default_pipeline_stages() -> list[PipelineStageInfo]:
    return [PipelineStageInfo(key=s, label=PIPELINE_LABELS[s]) for s in PipelineStage]
