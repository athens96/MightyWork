"""프로젝트 감사 로그 모델."""

from typing import Any

from app.models.common import Entity


class AuditLog(Entity):
    project_id: str
    actor_id: str
    action: str  # 예: member.added, project.ownership_transferred, wiki.restored
    target_type: str  # project | member | task | wiki | attachment | knowledge
    target_id: str
    summary: str
    details: dict[str, Any] = {}
