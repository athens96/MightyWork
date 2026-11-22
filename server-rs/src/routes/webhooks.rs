use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use rand::RngCore;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, utcnow, Permission, PipelineStage, ProjectWebhook, ProjectWebhookCreate,
    ProjectWebhookRead, ProjectWebhookUpdate, WebhookDelivery, WEBHOOK_EVENTS,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::webhooks::{deliver_now, dispatch_project_webhooks, validate_webhook_url};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/webhooks",
            get(list_webhooks).post(create_webhook),
        )
        .route(
            "/projects/{project_id}/webhooks/check-due-soon",
            post(check_due_soon),
        )
        .route(
            "/projects/{project_id}/webhooks/{webhook_id}",
            patch(update_webhook).delete(delete_webhook),
        )
        .route(
            "/projects/{project_id}/webhooks/{webhook_id}/test",
            post(test_webhook),
        )
        .route(
            "/projects/{project_id}/webhooks/{webhook_id}/deliveries",
            get(list_deliveries),
        )
}

fn gen_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn to_read(h: ProjectWebhook, generated_secret: Option<String>) -> ProjectWebhookRead {
    ProjectWebhookRead {
        id: h.id,
        project_id: h.project_id,
        name: h.name,
        url: h.url,
        preset: h.preset,
        events: h.events,
        trigger_tags: h.trigger_tags,
        trigger_stages: h.trigger_stages,
        has_secret: !h.secret.is_empty(),
        enabled: h.enabled,
        created_at: h.created_at.to_rfc3339(),
        updated_at: h.updated_at.to_rfc3339(),
        generated_secret,
    }
}

fn filter_events(events: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for e in events {
        if WEBHOOK_EVENTS.contains(&e.as_str()) && seen.insert(e.clone()) {
            out.push(e);
        }
    }
    if out.is_empty() {
        WEBHOOK_EVENTS.iter().map(|s| s.to_string()).collect()
    } else {
        out
    }
}

async fn list_webhooks(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<ProjectWebhookRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let mut hooks = state.db.project_webhooks.list_by_project(&access.project.id)?;
    hooks.sort_by_key(|h| h.created_at);
    Ok(Json(hooks.into_iter().map(|h| to_read(h, None)).collect()))
}

async fn create_webhook(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<ProjectWebhookCreate>,
) -> ApiResult<(StatusCode, Json<ProjectWebhookRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::unprocessable("name must be 1..80 chars"));
    }
    if !matches!(body.preset.as_str(), "custom" | "slack" | "discord") {
        return Err(ApiError::unprocessable("preset must be custom, slack, or discord"));
    }
    let url = validate_webhook_url(&body.url, state.webhook_sender.is_some())
        .map_err(ApiError::bad_request)?;

    let mut generated = None;
    let secret = if let Some(s) = body.secret {
        s.trim().to_string()
    } else if body.preset == "custom" {
        let s = gen_hex(20);
        generated = Some(s.clone());
        s
    } else {
        String::new()
    };

    let now = utcnow();
    let hook = ProjectWebhook {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        name,
        url,
        preset: body.preset,
        events: filter_events(body.events),
        trigger_tags: body
            .trigger_tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(20)
            .collect(),
        trigger_stages: body
            .trigger_stages
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(10)
            .collect(),
        secret,
        enabled: body.enabled,
        created_by: user.id.clone(),
    };
    state.db.project_webhooks.create(&hook)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "project.webhook_created",
        "webhook",
        &hook.id,
        format!("웹훅 '{}' ({}) 등록", hook.name, hook.preset),
        HashMap::new(),
    );
    Ok((StatusCode::CREATED, Json(to_read(hook, generated))))
}

async fn update_webhook(
    State(state): State<AppState>,
    Path((project_id, webhook_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<ProjectWebhookUpdate>,
) -> ApiResult<Json<ProjectWebhookRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let mut hook = state
        .db
        .project_webhooks
        .get(&webhook_id)?
        .ok_or_else(|| ApiError::not_found("Webhook not found"))?;
    if hook.project_id != access.project.id {
        return Err(ApiError::not_found("Webhook not found"));
    }
    if let Some(n) = body.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 80 {
            return Err(ApiError::unprocessable("name must be 1..80 chars"));
        }
        hook.name = trimmed;
    }
    if let Some(u) = body.url {
        hook.url = validate_webhook_url(&u, state.webhook_sender.is_some())
            .map_err(ApiError::bad_request)?;
    }
    if let Some(p) = body.preset {
        if !matches!(p.as_str(), "custom" | "slack" | "discord") {
            return Err(ApiError::unprocessable("preset must be custom, slack, or discord"));
        }
        hook.preset = p;
    }
    if let Some(evs) = body.events {
        hook.events = filter_events(evs);
    }
    if let Some(tags) = body.trigger_tags {
        hook.trigger_tags = tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(20)
            .collect();
    }
    if let Some(stages) = body.trigger_stages {
        hook.trigger_stages = stages
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(10)
            .collect();
    }
    if let Some(sec) = body.secret {
        hook.secret = sec.trim().to_string();
    }
    if let Some(en) = body.enabled {
        hook.enabled = en;
    }
    hook.updated_at = utcnow();
    state.db.project_webhooks.update(&hook)?;
    Ok(Json(to_read(hook, None)))
}

async fn delete_webhook(
    State(state): State<AppState>,
    Path((project_id, webhook_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let hook = state
        .db
        .project_webhooks
        .get(&webhook_id)?
        .ok_or_else(|| ApiError::not_found("Webhook not found"))?;
    if hook.project_id != access.project.id {
        return Err(ApiError::not_found("Webhook not found"));
    }
    for d in state
        .db
        .webhook_deliveries
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.webhook_id == hook.id)
    {
        state.db.webhook_deliveries.delete(&d.id)?;
    }
    state.db.project_webhooks.delete(&hook.id)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "project.webhook_deleted",
        "webhook",
        &hook.id,
        format!("웹훅 '{}' 삭제", hook.name),
        HashMap::new(),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn test_webhook(
    State(state): State<AppState>,
    Path((project_id, webhook_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<WebhookDelivery>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let hook = state
        .db
        .project_webhooks
        .get(&webhook_id)?
        .ok_or_else(|| ApiError::not_found("Webhook not found"))?;
    if hook.project_id != access.project.id {
        return Err(ApiError::not_found("Webhook not found"));
    }
    let link = format!(
        "{}/projects/{}/tasks",
        state.settings.app_url.trim_end_matches('/'),
        access.project.id
    );
    let delivery = deliver_now(
        &state.db,
        &hook,
        state.webhook_sender.as_ref(),
        "test",
        &access.project.key,
        &format!("{} 웹훅 테스트 발송", access.project.name),
        "MightyWork 외부 알림 연동이 정상적으로 연결되었습니다.",
        &link,
        None,
    )
    .await;
    Ok(Json(delivery))
}

async fn list_deliveries(
    State(state): State<AppState>,
    Path((project_id, webhook_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<WebhookDelivery>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let hook = state
        .db
        .project_webhooks
        .get(&webhook_id)?
        .ok_or_else(|| ApiError::not_found("Webhook not found"))?;
    if hook.project_id != access.project.id {
        return Err(ApiError::not_found("Webhook not found"));
    }
    let mut logs: Vec<WebhookDelivery> = state
        .db
        .webhook_deliveries
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|d| d.webhook_id == hook.id)
        .collect();
    logs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    logs.truncate(30);
    Ok(Json(logs))
}

async fn check_due_soon(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Value>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let cutoff = Utc::now().date_naive() + Duration::days(2);
    let due_tasks: Vec<_> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| {
            t.deleted_at.is_none()
                && t.stage != PipelineStage::Done
                && t.due_date.is_some_and(|d| d <= cutoff)
        })
        .collect();
    if due_tasks.is_empty() {
        return Ok(Json(json!({ "tasks": 0, "dispatched": 0 })));
    }
    let lines: Vec<String> = due_tasks
        .iter()
        .take(10)
        .map(|t| {
            format!(
                "- {}-{} {} (마감 {})",
                access.project.key,
                t.number,
                t.title,
                t.due_date.unwrap()
            )
        })
        .collect();
    let link = format!(
        "{}/projects/{}/tasks?due=soon",
        state.settings.app_url.trim_end_matches('/'),
        access.project.id
    );
    let ids: Vec<String> = due_tasks.iter().map(|t| t.id.clone()).collect();
    let dispatched = dispatch_project_webhooks(
        &state.db,
        state.webhook_sender.clone(),
        &access.project,
        "due_soon",
        format!("마감 임박 일감 {}건", due_tasks.len()),
        lines.join("\n"),
        link,
        Some(json!({ "task_ids": ids })),
    );
    Ok(Json(json!({ "tasks": due_tasks.len(), "dispatched": dispatched })))
}
