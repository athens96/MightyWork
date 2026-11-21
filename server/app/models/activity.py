from typing import Any, Literal

from app.models.common import Entity


class TaskActivity(Entity):
    """일감 변경 이력 한 건. old/new 는 JSON 값(날짜는 문자열)."""

    project_id: str
    task_id: str
    actor_id: str
    kind: Literal["created", "updated"]
    field: str | None = None
    old: Any = None
    new: Any = None
    via_client: str | None = None
