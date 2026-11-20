from datetime import datetime

from pydantic import BaseModel, Field

from app.models.common import Entity


class WikiPageBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = ""  # Markdown
    parent_id: str | None = None  # 계층 구조(노션/컨플루언스 스타일 트리)


class WikiPage(Entity, WikiPageBase):
    project_id: str
    created_by: str
    updated_by: str


class WikiPageCreate(WikiPageBase):
    pass


class WikiPageUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = None
    parent_id: str | None = None


class WikiPageSummary(BaseModel):
    """트리(사이드바)용 경량 응답 — 본문 제외."""

    id: str
    title: str
    parent_id: str | None
    updated_at: datetime
