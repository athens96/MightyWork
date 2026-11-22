"""버전별 릴리즈 대시보드 집계 및 체인지로그(Markdown) 생성 API."""

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DbDep, ProjectDep
from app.services.releases import (
    ReleaseChangelogResponse,
    ReleaseListResponse,
    build_changelog,
    build_releases,
)

router = APIRouter(prefix="/projects/{project_id}/releases", tags=["releases"])


@router.get("", response_model=ReleaseListResponse)
def list_releases(project: ProjectDep, db: DbDep) -> ReleaseListResponse:
    """프로젝트 내 모든 버전(task.version)의 진행률과 포함 일감을 최신 버전순으로 집계."""
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id)
    return build_releases(project, all_tasks)


@router.get("/{version}/changelog", response_model=ReleaseChangelogResponse)
def get_release_changelog(
    project: ProjectDep,
    version: str,
    db: DbDep,
    include_unfinished: bool = False,
) -> ReleaseChangelogResponse:
    """특정 버전의 완료 일감(선택적으로 미완료 포함)으로 Markdown 체인지로그를 자동 생성."""
    all_tasks = db.tasks.list(lambda t: t.project_id == project.id)
    res = build_changelog(project, all_tasks, version, include_unfinished=include_unfinished)
    if res is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Release '{version}' not found")
    return res
