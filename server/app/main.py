import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

from fastapi.responses import FileResponse, JSONResponse

from app.api.routes import (
    attachments,
    auth,
    comments,
    cycles,
    events,
    export,
    github,
    importer,
    knowledge,
    knowledge_base,
    members,
    milestones,
    notifications,
    oauth,
    projects,
    releases,
    tasks,
    templates,
    triage,
    users,
    views,
    webhooks,
    wiki,
)
from app.core.config import Settings
from app.core.version import APP_VERSION
from app.db import Database
from app.mcp_server import build_mcp, transport_security
from app.models.oauth import SCOPES
from app.services.migrations import migrate_version_tags
from app.services.oauth.server import Store, issuer, resource_url

logger = logging.getLogger("mightywork")


def create_app(settings: Settings | None = None, db: Database | None = None) -> FastAPI:
    settings = settings or Settings()
    if settings.jwt_secret == "change-me":
        logger.warning("JWT_SECRET is the default value. Set a strong secret in server/.env before deploying.")
    if db is None:
        db = Database.from_sqlite(settings.data_dir) if settings.db_backend == "sqlite" else Database.from_json_files(settings.data_dir)
    migrate_version_tags(db)

    # MCP 서버 (Streamable HTTP /mcp) — session_manager 는 앱을 만든 뒤에 생기므로 여기서 먼저 만든다
    mcp = build_mcp(settings, db)
    mcp_app = mcp.streamable_http_app(streamable_http_path="/mcp", transport_security=transport_security(settings))

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async with mcp.session_manager.run():  # 마운트한 하위 앱의 lifespan 은 실행되지 않으므로 여기서
            yield

    app = FastAPI(title=f"{settings.app_name} API", version=APP_VERSION, lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db
    app.state.oauth_store = db.make_oauth_store() or Store()
    app.state.mcp = mcp

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    api = APIRouter(prefix="/api")

    @api.get("/health", tags=["system"])
    def health() -> dict[str, str]:
        return {"status": "ok", "version": APP_VERSION}

    @api.get("/version", tags=["system"])
    def app_version() -> JSONResponse:
        return JSONResponse(
            {"name": settings.app_name, "version": APP_VERSION},
            headers={"Cache-Control": "no-store"},
        )

    @api.get("/mcp-info", tags=["system"])
    def mcp_info() -> dict[str, object]:
        """웹 앱 '연결된 앱' 화면용: MCP 접속 주소."""
        return {"url": resource_url(settings), "issuer": issuer(settings), "scopes": list(SCOPES)}

    api.include_router(auth.router)
    api.include_router(users.router)
    api.include_router(projects.router)
    api.include_router(members.router)
    api.include_router(tasks.pipeline_router)
    api.include_router(tasks.router)
    api.include_router(triage.router)
    api.include_router(templates.router)
    api.include_router(views.router)
    api.include_router(cycles.router)
    api.include_router(milestones.router)
    api.include_router(releases.router)
    api.include_router(comments.router)
    api.include_router(wiki.router)
    api.include_router(attachments.router)
    api.include_router(notifications.router)
    api.include_router(knowledge.router)
    api.include_router(knowledge_base.router)
    api.include_router(github.router)
    api.include_router(webhooks.router)
    api.include_router(events.router)
    api.include_router(export.router)
    api.include_router(importer.router)
    api.include_router(oauth.api)
    app.include_router(api)

    # OAuth 2.1 인가 서버 (/.well-known/oauth-authorization-server, /oauth/*)
    app.include_router(oauth.public)

    @app.get("/.well-known/oauth-protected-resource", include_in_schema=False)
    @app.get("/.well-known/oauth-protected-resource/mcp", include_in_schema=False)
    def protected_resource_metadata() -> JSONResponse:
        """RFC 9728 Protected Resource Metadata (루트·경로 버전 모두).
        SDK 기본 문서는 필수 scope(읽기)만 알리므로, 마운트보다 먼저 등록해 읽기+쓰기 둘 다 알린다 →
        클라이언트가 둘 다 요청하고, 사용자는 동의 화면에서 '읽기만'으로 줄일 수 있다."""
        return JSONResponse(
            {
                "resource": resource_url(settings),
                "authorization_servers": [issuer(settings)],
                "scopes_supported": list(SCOPES),
                "bearer_methods_supported": ["header"],
                "resource_name": settings.app_name,
            }
        )

    @app.get("/icon.png", include_in_schema=False)
    def icon() -> FileResponse:
        """앱 아이콘 (MCP 클라이언트가 서버 아이콘으로 표시)."""
        return FileResponse(Path(__file__).parent / "static/icon.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})

    # 마지막에: "/" 마운트는 모든 경로와 맞으므로 위의 라우트 뒤에 둔다 → /mcp, /.well-known/oauth-protected-resource/mcp
    app.mount("/", mcp_app)
    return app


app = create_app()
