"""프로젝트 저장된 일감 뷰(Custom Views) 모델."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.common import Entity

ViewLayout = Literal["board", "list", "timeline"]


class SavedView(Entity):
    project_id: str
    name: str = Field(min_length=1, max_length=60)
    layout: ViewLayout = "board"
    filters: dict[str, Any] = {}
    created_by: str


class SavedViewCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    layout: ViewLayout = "board"
    filters: dict[str, Any] = {}
