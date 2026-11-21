"""외부 알림 Webhook (Slack · Discord · Custom) 비동기 발송 · HMAC 서명 · 재시도 · 로그 기록."""

import hashlib
import hmac
import ipaddress
import json
import logging
import socket
import threading
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import requests

from app.db import Database
from app.models.integration import ProjectWebhook, WebhookDelivery
from app.models.project import Project

logger = logging.getLogger("mightywork.webhooks")

# 테스트에서 실제 외부 네트워크 없이 검증하기 위한 전송기 주입 훅: (url, body_bytes, headers) -> status_code
WebhookSender = Callable[[str, bytes, dict[str, str]], int]
_custom_sender: WebhookSender | None = None


def set_webhook_sender(sender: WebhookSender | None) -> None:
    global _custom_sender
    _custom_sender = sender


def validate_webhook_url(url: str, *, allow_private: bool = False) -> str:
    """SSRF 방어: https URL 만 허용하며, 사설·루프백 IP 를 차단한다."""
    clean = url.strip()
    parts = urlsplit(clean)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("Webhook URL 은 https:// 주소여야 합니다")
    host = parts.hostname
    if not allow_private:
        try:
            ip = ipaddress.ip_address(host)
            if not ip.is_global:
                raise ValueError("사설/루프백 IP 는 Webhook 대상으로 허용되지 않습니다")
        except ValueError as e:
            if "사설/루프백" in str(e):
                raise
            # 도메인명: 테스트 전송기가 없을 때만 실제 DNS 검사
            if _custom_sender is None:
                try:
                    infos = socket.getaddrinfo(host, parts.port or 443, type=socket.SOCK_STREAM)
                except socket.gaierror as ge:
                    raise ValueError(f"호스트를 찾을 수 없습니다: {host}") from ge
                for info in infos:
                    if not ipaddress.ip_address(info[4][0]).is_global:
                        raise ValueError(f"공개 IP 가 아닌 대상은 허용되지 않습니다: {host}")
    return clean


def format_webhook_payload(
    preset: str,
    *,
    event: str,
    project_key: str,
    title: str,
    body: str = "",
    link: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    summary = f"[{project_key}] {title}"
    if preset == "slack":
        text = f"*{summary}*" + (f"\n{body}" if body else "") + (f"\n<{link}|열기>" if link else "")
        return {"text": text}
    if preset == "discord":
        content = f"**{summary}**" + (f"\n{body}" if body else "") + (f"\n{link}" if link else "")
        return {"content": content[:1900]}
    return {
        "event": event,
        "project_key": project_key,
        "title": title,
        "body": body,
        "url": link,
        "data": extra or {},
    }


def _default_send(url: str, raw: bytes, headers: dict[str, str]) -> int:
    # 발송 시점에도 사설 IP 차단 재확인
    validate_webhook_url(url)
    res = requests.post(url, data=raw, headers=headers, timeout=5, allow_redirects=False)
    return res.status_code


def _deliver_now(
    db: Database,
    hook: ProjectWebhook,
    *,
    event: str,
    project_key: str,
    title: str,
    body: str,
    link: str,
    extra: dict[str, Any] | None,
    max_attempts: int = 2,
) -> WebhookDelivery:
    payload = format_webhook_payload(
        hook.preset,
        event=event,
        project_key=project_key,
        title=title,
        body=body,
        link=link,
        extra=extra,
    )
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "MightyWork-Webhook/1.0",
        "X-MightyWork-Event": event,
    }
    if hook.secret:
        sig = hmac.new(hook.secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
        headers["X-MightyWork-Signature-256"] = f"sha256={sig}"

    sender = _custom_sender or _default_send
    status_code: int | None = None
    ok = False
    err_msg = ""
    attempts = 0

    for attempt in range(1, max_attempts + 1):
        attempts = attempt
        try:
            status_code = int(sender(hook.url, raw, headers))
            if 200 <= status_code < 300:
                ok = True
                err_msg = ""
                break
            err_msg = f"HTTP {status_code}"
        except Exception as e:
            err_msg = str(e)[:200]
        if attempt < max_attempts and _custom_sender is None:
            time.sleep(0.5 * attempt)

    delivery = db.webhook_deliveries.create(
        WebhookDelivery(
            project_id=hook.project_id,
            webhook_id=hook.id,
            event=event,
            status_code=status_code,
            ok=ok,
            attempts=attempts,
            error=err_msg,
        )
    )
    # 로그 비대화 방지: 웹훅당 최근 50건 유지
    logs = sorted(db.webhook_deliveries.list(lambda d: d.webhook_id == hook.id), key=lambda d: d.created_at, reverse=True)
    for stale in logs[50:]:
        db.webhook_deliveries.delete(stale.id)
    return delivery


def deliver_webhook(
    db: Database,
    hook: ProjectWebhook,
    *,
    event: str,
    project_key: str,
    title: str,
    body: str = "",
    link: str = "",
    extra: dict[str, Any] | None = None,
    sync: bool = False,
) -> WebhookDelivery | None:
    if sync or _custom_sender is not None:
        return _deliver_now(db, hook, event=event, project_key=project_key, title=title, body=body, link=link, extra=extra)
    t = threading.Thread(
        target=_deliver_now,
        args=(db, hook),
        kwargs=dict(event=event, project_key=project_key, title=title, body=body, link=link, extra=extra),
        daemon=True,
    )
    t.start()
    return None


def _matches_hook_filters(hook: ProjectWebhook, extra: dict[str, Any] | None) -> bool:
    """AI 에이전트 자동화 훅용 레이블·단계 조건 필터링."""
    if not hook.trigger_tags and not hook.trigger_stages:
        return True
    data = extra or {}
    if hook.trigger_tags:
        wanted = {t.strip().casefold() for t in hook.trigger_tags if t.strip()}
        actual = {str(t).strip().casefold() for t in (data.get("tags") or [])}
        if not (wanted & actual):
            return False
    if hook.trigger_stages:
        wanted_stages = {s.strip().casefold() for s in hook.trigger_stages if s.strip()}
        actual_stage = str(data.get("stage") or "").strip().casefold()
        if actual_stage not in wanted_stages:
            return False
    return True


def dispatch_project_webhooks(
    db: Database,
    project: Project,
    *,
    event: str,
    title: str,
    body: str = "",
    link: str = "",
    extra: dict[str, Any] | None = None,
) -> int:
    """프로젝트에 등록된 활성 웹훅 중 해당 이벤트와 레이블/단계 조건이 일치하는 대상에 발송한다."""
    hooks = [
        h
        for h in db.project_webhooks.list(lambda h: h.project_id == project.id and h.enabled and event in h.events)
        if _matches_hook_filters(h, extra)
    ]
    for h in hooks:
        deliver_webhook(db, h, event=event, project_key=project.key, title=title, body=body, link=link, extra=extra)
    return len(hooks)
