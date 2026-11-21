"""외부 연동 모델 — GitHub 저장소 설정 및 PR/커밋 링크."""

from typing import Literal

from pydantic import BaseModel, Field

from app.models.common import Entity


class GitHubIntegration(Entity):
    project_id: str
    repo: str = Field(default="", max_length=200)  # 예: athens96/MightyWork
    webhook_secret: str = ""
    auto_transition: bool = True


class GitHubIntegrationUpdate(BaseModel):
    repo: str = Field(default="", max_length=200)
    webhook_secret: str | None = None  # None 이면 기존 값 유지
    rotate_secret: bool = False
    auto_transition: bool = True


class GitHubIntegrationRead(BaseModel):
    repo: str
    has_secret: bool
    auto_transition: bool
    webhook_url: str
    generated_secret: str | None = None  # 최초 생성·재발급 시 1회만 반환


class GitHubLink(Entity):
    project_id: str
    task_id: str
    kind: Literal["pr", "commit"]
    ref: str  # "#12" 또는 짧은 SHA
    title: str
    url: str
    state: str  # open | merged | closed | pushed
    author: str = ""
    branch: str = ""


WebhookPreset = Literal["custom", "slack", "discord"]
WEBHOOK_EVENTS: tuple[str, ...] = ("task.created", "task.stage_changed", "comment.created", "mention", "due_soon")


class ProjectWebhook(Entity):
    project_id: str
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=500)
    preset: WebhookPreset = "custom"
    events: list[str] = Field(default_factory=lambda: list(WEBHOOK_EVENTS))
    secret: str = ""
    enabled: bool = True
    created_by: str


class ProjectWebhookCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=500)
    preset: WebhookPreset = "custom"
    events: list[str] = Field(default_factory=lambda: list(WEBHOOK_EVENTS))
    secret: str | None = None
    enabled: bool = True


class ProjectWebhookUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    url: str | None = Field(default=None, min_length=8, max_length=500)
    preset: WebhookPreset | None = None
    events: list[str] | None = None
    secret: str | None = None
    enabled: bool | None = None


class ProjectWebhookRead(BaseModel):
    id: str
    project_id: str
    name: str
    url: str
    preset: WebhookPreset
    events: list[str]
    has_secret: bool
    enabled: bool
    created_at: str
    updated_at: str
    generated_secret: str | None = None


class WebhookDelivery(Entity):
    project_id: str
    webhook_id: str
    event: str
    status_code: int | None = None
    ok: bool = False
    attempts: int = 1
    error: str = ""


class ProjectIntake(Entity):
    project_id: str
    token: str
    enabled: bool = True
