use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::models::{utcnow, Notification};
use crate::routes::deps::AuthUser;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/notifications", get(list_notifications))
        .route("/notifications/{notification_id}/read", post(mark_read))
        .route("/notifications/read-all", post(mark_all_read))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    unread_only: bool,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct NotificationList {
    unread_count: usize,
    items: Vec<Notification>,
}

async fn list_notifications(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<NotificationList>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let mine = state.db.notifications.list_where(|n| n.user_id == user.id)?;
    let unread_count = mine.iter().filter(|n| !n.read).count();
    let mut items: Vec<Notification> = mine
        .into_iter()
        .filter(|n| !q.unread_only || !n.read)
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items.truncate(limit);
    Ok(Json(NotificationList { unread_count, items }))
}

async fn mark_read(
    State(state): State<AppState>,
    Path(notification_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Notification>> {
    let mut n = state
        .db
        .notifications
        .get(&notification_id)?
        .ok_or_else(|| ApiError::not_found("Notification not found"))?;
    if n.user_id != user.id {
        return Err(ApiError::not_found("Notification not found"));
    }
    if !n.read {
        n.read = true;
        n.updated_at = utcnow();
        state.db.notifications.update(&n)?;
    }
    Ok(Json(n))
}

async fn mark_all_read(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let now = utcnow();
    let mut updated = 0usize;
    for mut n in state
        .db
        .notifications
        .list_where(|n| n.user_id == user.id && !n.read)?
    {
        n.read = true;
        n.updated_at = now;
        state.db.notifications.update(&n)?;
        updated += 1;
    }
    Ok(Json(json!({ "updated": updated })))
}
