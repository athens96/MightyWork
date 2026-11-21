from pydantic import BaseModel, Field

from app.models.common import Entity


class Comment(Entity):
    project_id: str
    task_id: str
    author_id: str
    body: str  # Markdown
    via_client: str | None = None


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CommentUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)
