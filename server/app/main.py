import logging

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, comments, export, importer, knowledge, members, projects, tasks, users, wiki
from app.core.config import Settings
from app.db import Database

logger = logging.getLogger("mightywork")


def create_app(settings: Settings | None = None, db: Database | None = None) -> FastAPI:
    settings = settings or Settings()
    if settings.jwt_secret == "change-me":
        logger.warning("JWT_SECRET is the default value. Set a strong secret in server/.env before deploying.")

    app =FastAPI(title=f"{settings.app_name} API", version="0.1.0")
    app.state.settings = settings
    app.state.db = db or Database.from_json_files(settings.data_dir)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    api = APIRouter(prefix="/api")

    @api.get("/health", tags=["system"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    api.include_router(auth.router)
    api.include_router(users.router)
    api.include_router(projects.router)
    api.include_router(members.router)
    api.include_router(tasks.pipeline_router)
    api.include_router(tasks.router)
    api.include_router(comments.router)
    api.include_router(wiki.router)
    api.include_router(knowledge.router)
    api.include_router(export.router)
    api.include_router(importer.router)
    app.include_router(api)

    return app


app = create_app()
