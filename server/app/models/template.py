"""프로젝트별 일감 템플릿 모델 — 버그 제보·기능 제안·작업 체크리스트 프리셋."""

from pydantic import BaseModel, Field

from app.models.common import Entity
from app.models.task import PipelineStage, Priority


class TaskTemplateBase(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    title_prefix: str = Field(default="", max_length=40)
    description: str = Field(default="", max_length=20000)
    stage: PipelineStage = PipelineStage.BACKLOG
    priority: Priority = Priority.MEDIUM
    tags: list[str] = Field(default=[], max_length=30)
    checklist: list[str] = Field(default=[], max_length=50)


class TaskTemplate(Entity, TaskTemplateBase):
    project_id: str
    created_by: str


class TaskTemplateCreate(TaskTemplateBase):
    pass


class TaskTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    title_prefix: str | None = Field(default=None, max_length=40)
    description: str | None = Field(default=None, max_length=20000)
    stage: PipelineStage | None = None
    priority: Priority | None = None
    tags: list[str] | None = Field(default=None, max_length=30)
    checklist: list[str] | None = Field(default=None, max_length=50)
