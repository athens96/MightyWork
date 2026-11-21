"""프로젝트·사용자 실시간 이벤트 브로드캐스터 (SSE용, SQLite 멀티 워커 안전)."""

import asyncio
import json
import threading
from typing import Any

from app.db import Database

# 같은 워커 프로세스 내 구독자를 즉시 깨우기 위한 경량 시그널
_LOCK = threading.Lock()
_WAITERS: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()


def _notify_local_waiters() -> None:
    with _LOCK:
        waiters = list(_WAITERS)
    for loop, ev in waiters:
        if not loop.is_closed():
            loop.call_soon_threadsafe(ev.set)


def register_waiter(loop: asyncio.AbstractEventLoop) -> asyncio.Event:
    ev = asyncio.Event()
    with _LOCK:
        _WAITERS.add((loop, ev))
    return ev


def unregister_waiter(loop: asyncio.AbstractEventLoop, ev: asyncio.Event) -> None:
    with _LOCK:
        _WAITERS.discard((loop, ev))


def publish_event(db: Database, project_id: str, kind: str, payload: dict[str, Any] | None = None) -> int:
    """프로젝트 채널에 이벤트를 기록하고 로컬 구독자를 즉시 깨운다."""
    seq = db.append_event(project_id, kind, payload or {})
    _notify_local_waiters()
    return seq


def publish_user_event(db: Database, user_id: str, kind: str, payload: dict[str, Any] | None = None) -> int:
    """사용자 개인 채널(알림 등)에 이벤트를 기록한다."""
    seq = db.append_event(f"user:{user_id}", kind, payload or {})
    _notify_local_waiters()
    return seq


def format_sse(event: str, data: dict[str, Any], event_id: int | None = None) -> str:
    """W3C Server-Sent Events 프레임 문자열 생성."""
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data, ensure_ascii=False)}")
    return "\n".join(lines) + "\n\n"
