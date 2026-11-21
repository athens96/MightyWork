"""외부 알림 Webhook 관리(CRUD · 테스트 발송 · 로그 조회 · 마감 임박 체크) API."""

import secrets
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, SettingsDep, require
from app.models.common import utcnow
from app.models.integration import (
    WEBHOOK_EVENTS,
    ProjectWebhook,
    ProjectWebhookCreate,
    ProjectWebhookRead,
    ProjectWebhookUpdate,
    WebhookDelivery,
)
from app.models.member import Permission
from app.models.task import PipelineStage
from app.services.audit import record_audit
from app.services.webhooks import deliver_webhook, dispatch_project_webhooks, validate_webhook_url

router = APIRouter(prefix="/projects/{project_id}/webhooks", tags=["webhooks"])


def _to_read(h: ProjectWebhook, generated_secret: str | None = None) -> ProjectWebhookRead:
    return ProjectWebhookRead(
        id=h.id,
        project_id=h.project_id,
        name=h.name,
        url=h.url,
        preset=h.preset,
        events=h.events,
        has_secret=bool(h.secret),
        enabled=h.enabled,
        created_at=h.created_at.isoformat(),
        updated_at=h.updated_at.isoformat(),
        generated_secret=generated_secret,
    )


def _filter_events(events: list[str]) -> list[str]:
    allowed = set(WEBHOOK_EVENTS)
    picked = [e for e in dict.fromkeys(events) if e in allowed]
    return picked or list(WEBHOOK_EVENTS)


@router.get("", response_model=list[ProjectWebhookRead], dependencies=[require(Permission.ADMIN)])
def list_webhooks(project: ProjectDep, db: DbDep) -> list[ProjectWebhookRead]:
    hooks = sorted(db.project_webhooks.list(lambda h: h.project_id == project.id), key=lambda h: h.created_at)
    return [_to_read(h) for h in hooks]


@router.post("", response_model=ProjectWebhookRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.ADMIN)])
def create_webhook(project: ProjectDep, body: ProjectWebhookCreate, user: CurrentUser, db: DbDep) -> ProjectWebhookRead:
    try:
        url = validate_webhook_url(body.url)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    generated: str | None = None
    if body.secret is not None:
        secret = body.secret.strip()
    elif body.preset == "custom":
        secret = secrets.token_hex(20)
        generated = secret
    else:
        secret = ""

    hook = db.project_webhooks.create(
        ProjectWebhook(
            project_id=project.id,
            name=body.name.strip(),
            url=url,
            preset=body.preset,
            events=_filter_events(body.events),
            secret=secret,
            enabled=body.enabled,
            created_by=user.id,
        )
    )
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="project.webhook_created",
        target_type="webhook",
        target_id=hook.id,
        summary=f"웹훅 '{hook.name}' ({hook.preset}) 등록",
    )
    return _to_read(hook, generated_secret=generated)


@router.patch("/{webhook_id}", response_model=ProjectWebhookRead, dependencies=[require(Permission.ADMIN)])
def update_webhook(project: ProjectDep, webhook_id: str, body: ProjectWebhookUpdate, db: DbDep) -> ProjectWebhookRead:
    hook = db.project_webhooks.get(webhook_id)
    if hook is None or hook.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Webhook not found")
    patch: dict[str, object] = {}
    if body.name is not None:
        patch["name"] = body.name.strip()
    if body.url is not None:
        try:
            patch["url"] = validate_webhook_url(body.url)
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    if body.preset is not None:
        patch["preset"] = body.preset
    if body.events is not None:
        patch["events"] = _filter_events(body.events)
    if body.secret is not None:
        patch["secret"] = body.secret.strip()
    if body.enabled is not None:
        patch["enabled"] = body.enabled
    patch["updated_at"] = utcnow()
    updated = hook.model_copy(update=patch)
    db.project_webhooks.update(updated)
    return _to_read(updated)


@router.delete("/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.ADMIN)])
def delete_webhook(project: ProjectDep, webhook_id: str, user: CurrentUser, db: DbDep) -> Response:
    hook = db.project_webhooks.get(webhook_id)
    if hook is None or hook.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Webhook not found")
    for d in db.webhook_deliveries.list(lambda x: x.webhook_id == hook.id):
        db.webhook_deliveries.delete(d.id)
    db.project_webhooks.delete(hook.id)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="project.webhook_deleted",
        target_type="webhook",
        target_id=hook.id,
        summary=f"웹훅 '{hook.name}' 삭제",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{webhook_id}/test", response_model=WebhookDelivery, dependencies=[require(Permission.ADMIN)])
def test_webhook(project: ProjectDep, webhook_id: str, settings: SettingsDep, db: DbDep) -> WebhookDelivery:
    hook = db.project_webhooks.get(webhook_id)
    if hook is None or hook.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Webhook not found")
    delivery = deliver_webhook(
        db,
        hook,
        event="test",
        project_key=project.key,
        title=f"{project.name} 웹훅 테스트 발송",
        body="MightyWork 외부 알림 연동이 정상적으로 연결되었습니다.",
        link=f"{settings.app_url.rstrip('/')}/projects/{project.id}/tasks",
        sync=True,
    )
    assert delivery is not None
    return delivery


@router.get("/{webhook_id}/deliveries", response_model=list[WebhookDelivery], dependencies=[require(Permission.ADMIN)])
def list_deliveries(project: ProjectDep, webhook_id: str, db: DbDep) -> list[WebhookDelivery]:
    hook = db.project_webhooks.get(webhook_id)
    if hook is None or hook.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Webhook not found")
    return sorted(db.webhook_deliveries.list(lambda d: d.webhook_id == hook.id), key=lambda d: d.created_at, reverse=True)[:30]


@router.post("/check-due-soon", dependencies=[require(Permission.ADMIN)])
def check_due_soon(project: ProjectDep, settings: SettingsDep, db: DbDep) -> dict[str, int]:
    """마감일이 2일 이내로 임박한 미완료 일감에 대해 due_soon 웹훅을 발송한다."""
    cutoff = date.today() + timedelta(days=2)
    due_tasks = [
        t
        for t in db.tasks.list(lambda x: x.project_id == project.id)
        if t.stage != PipelineStage.DONE and t.due_date is not None and t.due_date <= cutoff
    ]
    if not due_tasks:
        return {"tasks": 0, "dispatched": 0}
    lines = [f"- {project.key}-{t.number} {t.title} (마감 {t.due_date})" for t in due_tasks[:10]]
    dispatched = dispatch_project_webhooks(
        db,
        project,
        event="due_soon",
        title=f"마감 임박 일감 {len(due_tasks)}건",
        body="\n".join(lines),
        link=f"{settings.app_url.rstrip('/')}/projects/{project.id}/tasks?due=soon",
        extra={"task_ids": [t.id for t in due_tasks]},
    )
    return {"tasks": len(due_tasks), "dispatched": dispatched}
