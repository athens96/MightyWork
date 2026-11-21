"""SSE 실시간 스트림 엔드포인트: 프로젝트 보드·일감 변경 및 사용자 알림 배지."""

import asyncio
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.api.deps import CurrentUser, DbDep, ProjectDep
from app.db import Database
from app.services.events import format_sse, register_waiter, unregister_waiter

router = APIRouter(tags=["events"])

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _parse_cursor(request: Request, since: int | None, db: Database) -> int:
    if since is not None:
        return max(0, since)
    raw = request.headers.get("last-event-id", "").strip()
    if raw.isdigit():
        return int(raw)
    return db.latest_event_seq()


async def _event_stream(
    request: Request,
    db: Database,
    channels: list[str],
    cursor: int,
    *,
    once: bool = False,
    poll_interval: float = 0.6,
    keepalive_sec: float = 20.0,
) -> AsyncIterator[str]:
    loop = asyncio.get_running_loop()
    waiter = register_waiter(loop)
    last_ping = time.monotonic()
    try:
        # 1) 초기 연결 확인 및 커서 이후 밀린 이벤트 즉시 전송
        pending = db.fetch_events(channels, cursor)
        if pending:
            cursor = pending[-1][0]
        yield format_sse("connected", {"seq": cursor}, event_id=cursor)
        for seq, kind, payload in pending:
            yield format_sse(kind, payload, event_id=seq)
        if once:
            return

        # 2) 실시간 스트리밍 루프 (같은 워커는 즉시, 다른 워커 SQLite 쓰기는 poll_interval 내 반영)
        while True:
            if await request.is_disconnected():
                break
            waiter.clear()
            events = db.fetch_events(channels, cursor)
            if events:
                for seq, kind, payload in events:
                    cursor = seq
                    yield format_sse(kind, payload, event_id=seq)
                last_ping = time.monotonic()
                continue

            now = time.monotonic()
            if now - last_ping >= keepalive_sec:
                yield ": keepalive\n\n"
                last_ping = now

            try:
                await asyncio.wait_for(waiter.wait(), timeout=poll_interval)
            except asyncio.TimeoutError:
                pass
    except asyncio.CancelledError:
        return
    finally:
        unregister_waiter(loop, waiter)


@router.get("/projects/{project_id}/events")
async def project_events(
    request: Request,
    project: ProjectDep,
    user: CurrentUser,
    db: DbDep,
    since: int | None = None,
    once: bool = False,
) -> StreamingResponse:
    """프로젝트 실시간 이벤트 스트림 (일감·덧글·GitHub·알림)."""
    cursor = _parse_cursor(request, since, db)
    channels = [project.id, f"user:{user.id}"]
    return StreamingResponse(_event_stream(request, db, channels, cursor, once=once), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/events")
async def user_events(
    request: Request,
    user: CurrentUser,
    db: DbDep,
    since: int | None = None,
    once: bool = False,
) -> StreamingResponse:
    """사용자 개인 알림 스트림 (사이드바 알림 배지 실시간 갱신)."""
    cursor = _parse_cursor(request, since, db)
    channels = [f"user:{user.id}"]
    return StreamingResponse(_event_stream(request, db, channels, cursor, once=once), media_type="text/event-stream", headers=_SSE_HEADERS)
