use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};

use crate::error::ApiResult;
use crate::models::User;
use crate::routes::deps::{require_project_access, AuthUser};
use crate::services::access::{project_related_users, visible_users_for};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users))
        .route("/projects/{project_id}/users", get(list_project_users))
}

async fn list_users(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Vec<User>>> {
    Ok(Json(visible_users_for(&state.db, &user)?))
}

async fn list_project_users(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<User>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    Ok(Json(project_related_users(&state.db, &access.project)?))
}
