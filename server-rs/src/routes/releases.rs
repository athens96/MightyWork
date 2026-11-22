use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::models::Task;
use crate::routes::deps::{require_project_access, AuthUser};
use crate::services::releases::{
    build_changelog, build_releases, ReleaseChangelogResponse, ReleaseListResponse,
};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/releases", get(list_releases))
        .route(
            "/projects/{project_id}/releases/{version}/changelog",
            get(get_release_changelog),
        )
}

async fn list_releases(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<ReleaseListResponse>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    Ok(Json(build_releases(&access.project, &all_tasks)))
}

#[derive(Debug, Deserialize)]
struct ChangelogQuery {
    #[serde(default)]
    include_unfinished: bool,
}

async fn get_release_changelog(
    State(state): State<AppState>,
    Path((project_id, version)): Path<(String, String)>,
    Query(q): Query<ChangelogQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<ReleaseChangelogResponse>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    let res = build_changelog(&access.project, &all_tasks, &version, q.include_unfinished, None)
        .ok_or_else(|| ApiError::not_found(format!("Release '{version}' not found")))?;
    Ok(Json(res))
}
