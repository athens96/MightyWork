from datetime import date
from enum import Enum

from pydantic import BaseModel, Field, model_validator

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


class TaskBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""  # Markdown
    stage: PipelineStage = PipelineStage.BACKLOG
    priority: Priority = Priority.MEDIUM
    assignee_id: str | None = None  # 작업자
    tags: list[str] = []  # 레이블
    start_date: date | None = None  # 시작일
    due_date: date | None = None  # 종료일(마감)
    estimate: int | None = Field(default=None, ge=0, le=100)  # 추정치(스토리 포인트)
    checklist: list[ChecklistItem] = Field(default=[], max_length=200)

    @model_validator(mode="after")
    def _check_dates(self):
        if self.start_date and self.due_date and self.start_date > self.due_date:
            raise ValueError("start_date must be on or before due_date")
        return self


class Task(Entity, TaskBase):
    project_id: str
    number: int  # 프로젝트 내 일련번호. 표시용 키는 f"{project.key}-{number}"
    created_by: str


class TaskRead(Task):
    """응답용: 저장하지 않는 계산 필드 포함."""

    comment_count: int = 0


class TaskCreate(TaskBase):
    pass


class TaskUpdate(BaseModel):
    """PATCH: 보낸 필드만 반영된다."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    stage: PipelineStage | None = None
    priority: Priority | None = None
    assignee_id: str | None = None
    tags: list[str] | None = None
    start_date: date | None = None
    due_date: date | None = None
    estimate: int | None = Field(default=None, ge=0, le=100)
    checklist: list[ChecklistItem] | None = Field(default=None, max_length=200)


class PipelineStageInfo(BaseModel):
    key: PipelineStage
    label: str
