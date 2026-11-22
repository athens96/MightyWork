use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{utcnow, Permission};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::events::publish_event;
use crate::services::tasks::{delete_task_cascade, delete_wiki_page_cascade};
use crate::AppState;

const TRASH_RETENTION_DAYS: i64 = 30;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/trash", get(list_trash))
        .route("/projects/{project_id}/trash/empty", post(empty_trash))
        .route(
            "/projects/{project_id}/trash/{kind}/{item_id}/restore",
            post(restore_trash_item),
        )
        .route(
            "/projects/{project_id}/trash/{kind}/{item_id}",
            delete(purge_trash_item),
        )
}

#[derive(Debug, Serialize)]
struct TrashItem {
    kind: &'static str,
    id: String,
    title: String,
    number: Option<i64>,
    deleted_at: DateTime<Utc>,
    deleted_by: Option<String>,
    days_left: i64,
}

fn purge_expired(db: &Database, project_id: &str) -> ApiResult<()> {
    let cutoff = utcnow() - Duration::days(TRASH_RETENTION_DAYS);
    for t in db
        .tasks
        .list_by_project(project_id)?
        .into_iter()
        .filter(|x| x.deleted_at.is_some_and(|d| d < cutoff))
    {
        delete_task_cascade(db, project_id, &t.id)?;
    }
    for p in db
        .wiki_pages
        .list_by_project(project_id)?
        .into_iter()
        .filter(|x| x.deleted_at.is_some_and(|d| d < cutoff))
    {
        delete_wiki_page_cascade(db, project_id, &p.id)?;
    }
    Ok(())
}

async fn list_trash(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TrashItem>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    purge_expired(&state.db, &access.project.id)?;
    let now = utcnow();
    let mut items = Vec::new();
    for t in state.db.tasks.list_by_project(&access.project.id)? {
        if let Some(del) = t.deleted_at {
            let left = (TRASH_RETENTION_DAYS - (now - del).num_days()).max(0);
            items.push(TrashItem {
                kind: "task",
                id: t.id,
                title: t.title,
                number: Some(t.number),
                deleted_at: del,
                deleted_by: t.deleted_by,
                days_left: left,
            });
        }
    }
    for p in state.db.wiki_pages.list_by_project(&access.project.id)? {
        if let Some(del) = p.deleted_at {
            let left = (TRASH_RETENTION_DAYS - (now - del).num_days()).max(0);
            items.push(TrashItem {
                kind: "wiki",
                id: p.id,
                title: p.title,
                number: None,
                deleted_at: del,
                deleted_by: p.deleted_by,
                days_left: left,
            });
        }
    }
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(Json(items))
}

async fn restore_trash_item(
    State(state): State<AppState>,
    Path((project_id, kind, item_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Value>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    match kind.as_str() {
        "task" => {
            let mut task = state
                .db
                .tasks
                .get(&item_id)?
                .ok_or_else(|| ApiError::not_found("Trashed task not found"))?;
            if task.project_id != access.project.id || task.deleted_at.is_none() {
                return Err(ApiError::not_found("Trashed task not found"));
            }
            if let Some(ref pid) = task.parent_id {
                let valid = state
                    .db
                    .tasks
                    .get(pid)?
                    .is_some_and(|p| p.deleted_at.is_none());
                if !valid {
                    task.parent_id = None;
                }
            }
            task.deleted_at = None;
            task.deleted_by = None;
            task.updated_at = utcnow();
            state.db.tasks.update(&task)?;
            let key = format!("{}-{}", access.project.key, task.number);
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "task.restored",
                "task",
                &task.id,
                format!("{key} {} 휴지통에서 복구", task.title),
                HashMap::new(),
            );
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "task.created",
                json!({ "task_id": task.id, "stage": task.stage.as_str() }),
            );
            Ok(Json(json!({ "kind": "task", "id": task.id })))
        }
        "wiki" => {
            let mut page = state
                .db
                .wiki_pages
                .get(&item_id)?
                .ok_or_else(|| ApiError::not_found("Trashed page not found"))?;
            if page.project_id != access.project.id || page.deleted_at.is_none() {
                return Err(ApiError::not_found("Trashed page not found"));
            }
            if let Some(ref pid) = page.parent_id {
                let valid = state
                    .db
                    .wiki_pages
                    .get(pid)?
                    .is_some_and(|p| p.deleted_at.is_none());
                if !valid {
                    page.parent_id = None;
                }
            }
            page.deleted_at = None;
            page.deleted_by = None;
            page.updated_at = utcnow();
            state.db.wiki_pages.update(&page)?;
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "wiki.restored_from_trash",
                "wiki",
                &page.id,
                format!("위키 '{}' 휴지통에서 복구", page.title),
                HashMap::new(),
            );
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "wiki.updated",
                json!({ "page_id": page.id }),
            );
            Ok(Json(json!({ "kind": "wiki", "id": page.id })))
        }
        _ => Err(ApiError::unprocessable("kind must be 'task' or 'wiki'")),
    }
}

async fn purge_trash_item(
    State(state): State<AppState>,
    Path((project_id, kind, item_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    match kind.as_str() {
        "task" => {
            let task = state
                .db
                .tasks
                .get(&item_id)?
                .ok_or_else(|| ApiError::not_found("Trashed task not found"))?;
            if task.project_id != access.project.id || task.deleted_at.is_none() {
                return Err(ApiError::not_found("Trashed task not found"));
            }
            let key = format!("{}-{}", access.project.key, task.number);
            delete_task_cascade(&state.db, &access.project.id, &task.id)?;
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "task.purged",
                "task",
                &task.id,
                format!("{key} {} 영구 삭제", task.title),
                HashMap::new(),
            );
            Ok(StatusCode::NO_CONTENT)
        }
        "wiki" => {
            let page = state
                .db
                .wiki_pages
                .get(&item_id)?
                .ok_or_else(|| ApiError::not_found("Trashed page not found"))?;
            if page.project_id != access.project.id || page.deleted_at.is_none() {
                return Err(ApiError::not_found("Trashed page not found"));
            }
            delete_wiki_page_cascade(&state.db, &access.project.id, &page.id)?;
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "wiki.purged",
                "wiki",
                &page.id,
                format!("위키 '{}' 영구 삭제", page.title),
                HashMap::new(),
            );
            Ok(StatusCode::NO_CONTENT)
        }
        _ => Err(ApiError::unprocessable("kind must be 'task' or 'wiki'")),
    }
}

async fn empty_trash(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Value>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let mut purged = 0usize;
    for t in state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.deleted_at.is_some())
    {
        delete_task_cascade(&state.db, &access.project.id, &t.id)?;
        purged += 1;
    }
    for p in state
        .db
        .wiki_pages
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.deleted_at.is_some())
    {
        delete_wiki_page_cascade(&state.db, &access.project.id, &p.id)?;
        purged += 1;
    }
    if purged > 0 {
        record_audit(
            &state.db,
            &access.project.id,
            &user.id,
            "trash.emptied",
            "project",
            &access.project.id,
            format!("휴지통 비우기 ({purged}건 영구 삭제)"),
            HashMap::new(),
        );
    }
    Ok(Json(json!({ "purged": purged })))
}
