"""프로젝트 감사 로그 기록."""

from typing import Any

from app.db import Database
from app.models.audit import AuditLog


def record_audit(
    db: Database,
    *,
    project_id: str,
    actor_id: str,
    action: str,
    target_type: str,
    target_id: str,
    summary: str,
    details: dict[str, Any] | None = None,
) -> AuditLog:
    return db.audit_logs.create(
        AuditLog(
            project_id=project_id,
            actor_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            summary=summary,
            details=details or {},
        )
    )
