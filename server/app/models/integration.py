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
