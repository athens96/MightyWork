use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Duration, NaiveDate, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, utcnow, Permission, PipelineStage, Priority, ProjectIntake, Task, TaskLink,
    TaskLinkKind, TaskRead,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::events::publish_event;
use crate::services::tasks::{record_changes, record_created};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/triage",
            get(list_triage).post(create_triage_item),
        )
        .route(
            "/projects/{project_id}/triage/{task_id}/decide",
            post(decide_triage_item),
        )
        .route(
            "/projects/{project_id}/intake",
            get(get_intake_config).put(update_intake_config),
        )
        .route("/intake/{token}", post(submit_public_intake))
}

fn gen_token() -> String {
    let mut bytes = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn const_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn to_read(db: &Database, t: Task) -> ApiResult<TaskRead> {
    let cc = db
        .comments
        .list_by_project(&t.project_id)?
        .into_iter()
        .filter(|c| c.task_id == t.id)
        .count();
    Ok(TaskRead {
        task: t,
        comment_count: cc,
        subtask_count: 0,
        subtask_done: 0,
        blocked_by_count: 0,
    })
}

fn find_intake(db: &Database, project_id: &str) -> ApiResult<Option<ProjectIntake>> {
    Ok(db
        .project_intakes
        .list_by_project(project_id)?
        .into_iter()
        .next())
}

#[derive(Debug, Deserialize)]
struct TriageListQuery {
    #[serde(default)]
    include_declined: bool,
}

async fn list_triage(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<TriageListQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TaskRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let today = Utc::now().date_naive();
    let mut items = Vec::new();

    for mut t in state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.deleted_at.is_none() && x.triage_status.is_some())
    {
        if t.triage_status.as_deref() == Some("snoozed")
            && t.triage_snooze_until.is_some_and(|d| d <= today)
        {
            t.triage_status = Some("pending".into());
            t.triage_snooze_until = None;
            t.updated_at = utcnow();
            state.db.tasks.update(&t)?;
        }
        if t.triage_status.as_deref() == Some("declined") && !q.include_declined {
            continue;
        }
        items.push(t);
    }

    let rank = |s: Option<&str>| match s.unwrap_or("pending") {
        "pending" => 0,
        "snoozed" => 1,
        "declined" => 2,
        _ => 9,
    };
    items.sort_by(|a, b| {
        rank(a.triage_status.as_deref())
            .cmp(&rank(b.triage_status.as_deref()))
            .then_with(|| b.created_at.cmp(&a.created_at))
    });

    let mut out = Vec::with_capacity(items.len());
    for t in items {
        out.push(to_read(&state.db, t)?);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
struct TriageCreate {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    priority: Priority,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    source: String,
}

async fn create_triage_item(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<TriageCreate>,
) -> ApiResult<(StatusCode, Json<TaskRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let title = body.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::unprocessable("title must be 1..200 chars"));
    }
    let number = state
        .db
        .allocate_task_number(&access.project.id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    let source = {
        let s = body.source.trim();
        if !s.is_empty() {
            s.chars().take(120).collect()
        } else if !user.name.is_empty() {
            user.name.clone()
        } else {
            user.email.clone()
        }
    };
    let now = utcnow();
    let task = Task {
        id: new_id(),
        created_at: now,
        updated_at: now,
        title,
        description: body.description.chars().take(20000).collect(),
        stage: PipelineStage::Backlog,
        priority: body.priority,
        parent_id: None,
        cycle_id: None,
        milestone_id: None,
        version: None,
        assignee_id: None,
        tags: body
            .tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(20)
            .collect(),
        start_date: None,
        due_date: None,
        estimate: None,
        checklist: vec![],
        triage_status: Some("pending".into()),
        triage_snooze_until: None,
        triage_source: source,
        project_id: access.project.id.clone(),
        number,
        created_by: user.id.clone(),
        watcher_ids: vec![],
        deleted_at: None,
        deleted_by: None,
        via_client: None,
    };
    state.db.tasks.create(&task)?;
    record_created(&state.db, &task, &user.id, None);
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "triage.updated",
        json!({ "task_id": task.id }),
    );
    Ok((StatusCode::CREATED, Json(to_read(&state.db, task)?)))
}

#[derive(Debug, Deserialize)]
struct TriageDecision {
    action: String,
    #[serde(default)]
    target_stage: PipelineStage,
    #[serde(default)]
    duplicate_of_id: Option<String>,
    #[serde(default)]
    snooze_until: Option<NaiveDate>,
}

async fn decide_triage_item(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<TriageDecision>,
) -> ApiResult<Json<TaskRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let task = state
        .db
        .tasks
        .get(&task_id)?
        .ok_or_else(|| ApiError::not_found("Triage item not found"))?;
    if task.project_id != access.project.id || task.triage_status.is_none() || task.deleted_at.is_some() {
        return Err(ApiError::not_found("Triage item not found"));
    }

    let key = format!("{}-{}", access.project.key, task.number);
    match body.action.as_str() {
        "accept" => {
            let mut updated = task.clone();
            updated.triage_status = None;
            updated.triage_snooze_until = None;
            updated.stage = body.target_stage;
            updated.updated_at = utcnow();
            state.db.tasks.update(&updated)?;
            record_changes(&state.db, &task, &updated, &user.id, None);
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "triage.accepted",
                "task",
                &task.id,
                format!("{key} 트리아지 수락 → {}", body.target_stage.as_str()),
                HashMap::new(),
            );
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "task.created",
                json!({ "task_id": updated.id, "stage": updated.stage.as_str() }),
            );
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "triage.updated",
                json!({ "task_id": updated.id }),
            );
            Ok(Json(to_read(&state.db, updated)?))
        }
        "duplicate" => {
            let dup_id = body
                .duplicate_of_id
                .as_deref()
                .filter(|id| !id.is_empty() && *id != task.id)
                .ok_or_else(|| ApiError::bad_request("duplicate_of_id is required"))?;
            let target = state
                .db
                .tasks
                .get(dup_id)?
                .ok_or_else(|| ApiError::not_found("Target task not found"))?;
            if target.project_id != access.project.id {
                return Err(ApiError::not_found("Target task not found"));
            }
            let exists = state
                .db
                .task_links
                .list_by_project(&access.project.id)?
                .into_iter()
                .any(|l| {
                    l.source_id == task.id
                        && l.target_id == target.id
                        && l.kind == TaskLinkKind::Duplicates
                });
            if !exists {
                let now = utcnow();
                state.db.task_links.create(&TaskLink {
                    id: new_id(),
                    created_at: now,
                    updated_at: now,
                    project_id: access.project.id.clone(),
                    source_id: task.id.clone(),
                    target_id: target.id.clone(),
                    kind: TaskLinkKind::Duplicates,
                    created_by: user.id.clone(),
                })?;
            }
            let mut updated = task.clone();
            updated.triage_status = Some("declined".into());
            updated.triage_snooze_until = None;
            updated.stage = PipelineStage::Done;
            updated.updated_at = utcnow();
            state.db.tasks.update(&updated)?;
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "triage.duplicated",
                "task",
                &task.id,
                format!("{key} 중복 병합 → {}-{}", access.project.key, target.number),
                HashMap::new(),
            );
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "triage.updated",
                json!({ "task_id": updated.id }),
            );
            Ok(Json(to_read(&state.db, updated)?))
        }
        "snooze" => {
            let until = body
                .snooze_until
                .unwrap_or_else(|| Utc::now().date_naive() + Duration::days(3));
            let mut updated = task.clone();
            updated.triage_status = Some("snoozed".into());
            updated.triage_snooze_until = Some(until);
            updated.updated_at = utcnow();
            state.db.tasks.update(&updated)?;
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "triage.updated",
                json!({ "task_id": updated.id }),
            );
            Ok(Json(to_read(&state.db, updated)?))
        }
        "decline" => {
            let mut updated = task.clone();
            updated.triage_status = Some("declined".into());
            updated.triage_snooze_until = None;
            updated.updated_at = utcnow();
            state.db.tasks.update(&updated)?;
            record_audit(
                &state.db,
                &access.project.id,
                &user.id,
                "triage.declined",
                "task",
                &task.id,
                format!("{key} 트리아지 거절"),
                HashMap::new(),
            );
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "triage.updated",
                json!({ "task_id": updated.id }),
            );
            Ok(Json(to_read(&state.db, updated)?))
        }
        _ => Err(ApiError::unprocessable("action must be accept, duplicate, snooze, or decline")),
    }
}

#[derive(Debug, Serialize)]
struct IntakeConfigRead {
    enabled: bool,
    token: String,
    intake_url: String,
}

#[derive(Debug, Deserialize)]
struct IntakeConfigUpdate {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    rotate_token: bool,
}

fn default_true() -> bool {
    true
}

async fn get_intake_config(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<IntakeConfigRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let Some(cfg) = find_intake(&state.db, &access.project.id)? else {
        return Ok(Json(IntakeConfigRead {
            enabled: false,
            token: String::new(),
            intake_url: String::new(),
        }));
    };
    let intake_url = format!("{}/api/intake/{}", state.settings.base_url(), cfg.token);
    Ok(Json(IntakeConfigRead {
        enabled: cfg.enabled,
        token: cfg.token,
        intake_url,
    }))
}

async fn update_intake_config(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<IntakeConfigUpdate>,
) -> ApiResult<Json<IntakeConfigRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let cfg = match find_intake(&state.db, &access.project.id)? {
        None => {
            let now = utcnow();
            let c = ProjectIntake {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: access.project.id.clone(),
                token: gen_token(),
                enabled: body.enabled,
            };
            state.db.project_intakes.create(&c)?
        }
        Some(mut existing) => {
            if body.rotate_token {
                existing.token = gen_token();
            }
            existing.enabled = body.enabled;
            existing.updated_at = utcnow();
            state.db.project_intakes.update(&existing)?;
            existing
        }
    };
    let intake_url = format!("{}/api/intake/{}", state.settings.base_url(), cfg.token);
    Ok(Json(IntakeConfigRead {
        enabled: cfg.enabled,
        token: cfg.token,
        intake_url,
    }))
}

#[derive(Debug, Deserialize)]
struct PublicIntakeSubmission {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    reporter_name: String,
    #[serde(default)]
    reporter_email: String,
    #[serde(default)]
    priority: Priority,
    #[serde(default)]
    tags: Vec<String>,
}

async fn submit_public_intake(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<PublicIntakeSubmission>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let title = body.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::unprocessable("title must be 1..200 chars"));
    }
    let found = state
        .db
        .project_intakes
        .list()?
        .into_iter()
        .find(|x| x.enabled && const_eq(&x.token, &token))
        .ok_or_else(|| ApiError::not_found("Invalid or disabled intake token"))?;
    let project = state
        .db
        .projects
        .get(&found.project_id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;

    let parts: Vec<&str> = [body.reporter_name.trim(), body.reporter_email.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let source = if parts.is_empty() {
        "외부 제보".to_string()
    } else {
        parts.join(" / ")
    };
    let mut desc = body.description.trim().to_string();
    if !parts.is_empty() {
        desc = format!("> 제보자: {source}\n\n{desc}").trim().to_string();
    }

    let mut seen = HashSet::new();
    let mut tags = vec!["intake".to_string()];
    seen.insert("intake".to_string());
    for raw in body.tags.into_iter().take(10) {
        let t = raw.trim().to_string();
        if !t.is_empty() && seen.insert(t.clone()) {
            tags.push(t);
        }
    }

    let number = state
        .db
        .allocate_task_number(&project.id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    let now = utcnow();
    let task = Task {
        id: new_id(),
        created_at: now,
        updated_at: now,
        title,
        description: desc.chars().take(20000).collect(),
        stage: PipelineStage::Backlog,
        priority: body.priority,
        parent_id: None,
        cycle_id: None,
        milestone_id: None,
        version: None,
        assignee_id: None,
        tags,
        start_date: None,
        due_date: None,
        estimate: None,
        checklist: vec![],
        triage_status: Some("pending".into()),
        triage_snooze_until: None,
        triage_source: source,
        project_id: project.id.clone(),
        number,
        created_by: project.created_by.clone(),
        watcher_ids: vec![],
        deleted_at: None,
        deleted_by: None,
        via_client: None,
    };
    state.db.tasks.create(&task)?;
    record_created(&state.db, &task, "intake", None);
    publish_event(
        &state.db,
        &state.events,
        &project.id,
        "triage.updated",
        json!({ "task_id": task.id }),
    );
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "key": format!("{}-{}", project.key, task.number),
            "task_id": task.id,
            "status": "pending",
        })),
    ))
}
