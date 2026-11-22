use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::json;

use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, toggle_reaction_map, utcnow, Comment, CommentBody, Permission, ReactionToggle,
    TaskActivity, ALLOWED_REACTIONS,
};
use crate::routes::deps::{require_active_task, require_perm, require_project_access, AuthUser};
use crate::services::events::publish_event;
use crate::services::notifications::{notify_mentions, notify_user};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/tasks/{task_id}/comments",
            get(list_comments).post(create_comment),
        )
        .route(
            "/projects/{project_id}/tasks/{task_id}/comments/{comment_id}",
            patch(update_comment).delete(delete_comment),
        )
        .route(
            "/projects/{project_id}/tasks/{task_id}/comments/{comment_id}/reactions",
            post(toggle_comment_reaction),
        )
        .route("/projects/{project_id}/tasks/{task_id}/activity", get(list_activity))
}

async fn list_comments(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<Comment>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut items: Vec<Comment> = state
        .db
        .comments
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|c| c.task_id == task.id)
        .collect();
    items.sort_by_key(|c| c.created_at);
    Ok(Json(items))
}

async fn create_comment(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<CommentBody>,
) -> ApiResult<(StatusCode, Json<Comment>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    if body.body.is_empty() || body.body.chars().count() > 20_000 {
        return Err(ApiError::unprocessable("body must be 1..20000 chars"));
    }

    let now = utcnow();
    let comment = Comment {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: task.project_id.clone(),
        task_id: task.id.clone(),
        author_id: user.id.clone(),
        body: body.body,
        reactions: HashMap::new(),
        via_client: None,
    };
    state.db.comments.create(&comment)?;

    let link = format!("/projects/{}/tasks/{}", access.project.id, task.id);
    let key = format!("{}-{}", access.project.key, task.number);
    let mentioned = notify_mentions(
        &state.db,
        &state.events,
        &access.project,
        &user,
        &comment.body,
        &format!("{key} '{}' 덧글에서 나를 언급했습니다", task.title),
        &link,
    );
    let already: HashSet<String> = mentioned.into_iter().map(|n| n.user_id).collect();
    let mut recipients: HashSet<String> = HashSet::new();
    if let Some(a) = &task.assignee_id {
        recipients.insert(a.clone());
    }
    recipients.insert(task.created_by.clone());
    for w in &task.watcher_ids {
        recipients.insert(w.clone());
    }
    let excerpt: String = comment
        .body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(140)
        .collect();
    for uid in recipients {
        if !already.contains(&uid) {
            notify_user(
                &state.db,
                &state.events,
                &uid,
                &access.project.id,
                &user.id,
                "comment",
                &format!("{key} '{}' 에 새 덧글이 달렸습니다", task.title),
                &excerpt,
                &link,
            );
        }
    }

    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "comment.created",
        json!({ "task_id": task.id, "comment_id": comment.id }),
    );
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn update_comment(
    State(state): State<AppState>,
    Path((project_id, task_id, comment_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<CommentBody>,
) -> ApiResult<Json<Comment>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut comment = state
        .db
        .comments
        .get(&comment_id)?
        .ok_or_else(|| ApiError::not_found("Comment not found"))?;
    if comment.task_id != task.id {
        return Err(ApiError::not_found("Comment not found"));
    }
    if comment.author_id != user.id {
        return Err(ApiError::forbidden("Only the author can modify this comment"));
    }
    if body.body.is_empty() || body.body.chars().count() > 20_000 {
        return Err(ApiError::unprocessable("body must be 1..20000 chars"));
    }
    comment.body = body.body;
    comment.updated_at = utcnow();
    state.db.comments.update(&comment)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "comment.updated",
        json!({ "task_id": task.id, "comment_id": comment.id }),
    );
    Ok(Json(comment))
}

async fn delete_comment(
    State(state): State<AppState>,
    Path((project_id, task_id, comment_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let comment = state
        .db
        .comments
        .get(&comment_id)?
        .ok_or_else(|| ApiError::not_found("Comment not found"))?;
    if comment.task_id != task.id {
        return Err(ApiError::not_found("Comment not found"));
    }
    if comment.author_id != user.id && !access.can(Permission::Admin) {
        return Err(ApiError::forbidden("Only the author can modify this comment"));
    }
    state.db.comments.delete(&comment.id)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "comment.deleted",
        json!({ "task_id": task.id, "comment_id": comment.id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn toggle_comment_reaction(
    State(state): State<AppState>,
    Path((project_id, task_id, comment_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<ReactionToggle>,
) -> ApiResult<Json<Comment>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    if !ALLOWED_REACTIONS.contains(&body.emoji.as_str()) {
        return Err(ApiError::bad_request("Unsupported reaction emoji"));
    }
    let mut comment = state
        .db
        .comments
        .get(&comment_id)?
        .ok_or_else(|| ApiError::not_found("Comment not found"))?;
    if comment.task_id != task.id {
        return Err(ApiError::not_found("Comment not found"));
    }
    comment.reactions = toggle_reaction_map(&comment.reactions, &body.emoji, &user.id);
    state.db.comments.update(&comment)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "comment.updated",
        json!({ "task_id": task.id, "comment_id": comment.id }),
    );
    Ok(Json(comment))
}

async fn list_activity(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TaskActivity>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut items: Vec<TaskActivity> = state
        .db
        .task_activities
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|a| a.task_id == task.id)
        .collect();
    items.sort_by_key(|a| a.created_at);
    Ok(Json(items))
}
