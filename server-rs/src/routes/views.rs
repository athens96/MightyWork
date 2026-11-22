use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};

use crate::error::{ApiError, ApiResult};
use crate::models::{new_id, utcnow, Permission, SavedView, SavedViewCreate};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/views", get(list_views).post(create_view))
        .route("/projects/{project_id}/views/{view_id}", delete(delete_view))
}

async fn list_views(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<SavedView>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut views = state.db.saved_views.list_by_project(&access.project.id)?;
    views.sort_by_key(|v| v.created_at);
    Ok(Json(views))
}

async fn create_view(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<SavedViewCreate>,
) -> ApiResult<(StatusCode, Json<SavedView>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ApiError::unprocessable("name must be 1..60 chars"));
    }
    if !matches!(body.layout.as_str(), "board" | "list" | "timeline") {
        return Err(ApiError::unprocessable("layout must be board, list, or timeline"));
    }
    let now = utcnow();
    let v = SavedView {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id,
        name,
        layout: body.layout,
        filters: body.filters,
        created_by: user.id,
    };
    state.db.saved_views.create(&v)?;
    Ok((StatusCode::CREATED, Json(v)))
}

async fn delete_view(
    State(state): State<AppState>,
    Path((project_id, view_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    let v = state
        .db
        .saved_views
        .get(&view_id)?
        .ok_or_else(|| ApiError::not_found("View not found"))?;
    if v.project_id != access.project.id {
        return Err(ApiError::not_found("View not found"));
    }
    if v.created_by != user.id && !access.can(Permission::Delete) && !access.can(Permission::Admin) {
        return Err(ApiError::forbidden("Not allowed to delete this view"));
    }
    state.db.saved_views.delete(&v.id)?;
    Ok(StatusCode::NO_CONTENT)
}
