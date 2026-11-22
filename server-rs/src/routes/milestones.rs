use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use chrono::NaiveDate;
use serde_json::json;

use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, utcnow, Milestone, MilestoneCreate, MilestoneRead, MilestoneUpdate, Permission,
    PipelineStage, Task,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::events::publish_event;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/milestones",
            get(list_milestones).post(create_milestone),
        )
        .route(
            "/projects/{project_id}/milestones/{milestone_id}",
            patch(update_milestone).delete(delete_milestone),
        )
}

fn status_rank(s: &str) -> u8 {
    match s {
        "active" => 0,
        "planned" => 1,
        "completed" => 2,
        _ => 9,
    }
}

fn validate_status(s: &str) -> ApiResult<()> {
    if !matches!(s, "planned" | "active" | "completed") {
        return Err(ApiError::unprocessable("status must be planned, active, or completed"));
    }
    Ok(())
}

pub fn build_milestone_read(m: Milestone, all_tasks: &[Task]) -> MilestoneRead {
    let items: Vec<&Task> = all_tasks
        .iter()
        .filter(|t| t.milestone_id.as_deref() == Some(&m.id) && t.triage_status.is_none())
        .collect();
    let total = items.len();
    let done = items.iter().filter(|t| t.stage == PipelineStage::Done).count();
    let in_prog = items
        .iter()
        .filter(|t| {
            matches!(
                t.stage,
                PipelineStage::InProgress | PipelineStage::Review | PipelineStage::Qa
            )
        })
        .count();
    let total_pts: i64 = items.iter().map(|t| t.estimate.unwrap_or(0)).sum();
    let done_pts: i64 = items
        .iter()
        .filter(|t| t.stage == PipelineStage::Done)
        .map(|t| t.estimate.unwrap_or(0))
        .sum();
    let pct = if total > 0 {
        ((done as f64 / total as f64) * 100.0).round() as i64
    } else {
        0
    };
    MilestoneRead {
        milestone: m,
        total_tasks: total,
        done_tasks: done,
        in_progress_tasks: in_prog,
        total_points: total_pts,
        done_points: done_pts,
        progress_pct: pct,
    }
}

async fn list_milestones(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<MilestoneRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut items = state.db.milestones.list_by_project(&access.project.id)?;
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    items.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then_with(|| a.target_date.is_none().cmp(&b.target_date.is_none()))
            .then_with(|| {
                a.target_date
                    .unwrap_or(NaiveDate::MAX)
                    .cmp(&b.target_date.unwrap_or(NaiveDate::MAX))
            })
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    Ok(Json(
        items
            .into_iter()
            .map(|m| build_milestone_read(m, &all_tasks))
            .collect(),
    ))
}

async fn create_milestone(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<MilestoneCreate>,
) -> ApiResult<(StatusCode, Json<MilestoneRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    validate_status(&body.status)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::unprocessable("name must be 1..120 chars"));
    }
    if let (Some(s), Some(t)) = (body.start_date, body.target_date) {
        if s > t {
            return Err(ApiError::unprocessable("start_date must be on or before target_date"));
        }
    }
    let now = utcnow();
    let m = Milestone {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        name,
        description: body.description.chars().take(1000).collect(),
        start_date: body.start_date,
        target_date: body.target_date,
        status: body.status,
        created_by: user.id.clone(),
    };
    state.db.milestones.create(&m)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "milestone.created",
        "milestone",
        &m.id,
        format!("마일스톤 '{}' 생성", m.name),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "milestone.updated",
        json!({ "milestone_id": m.id }),
    );
    Ok((StatusCode::CREATED, Json(build_milestone_read(m, &[]))))
}

async fn update_milestone(
    State(state): State<AppState>,
    Path((project_id, milestone_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<MilestoneUpdate>,
) -> ApiResult<Json<MilestoneRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut m = state
        .db
        .milestones
        .get(&milestone_id)?
        .ok_or_else(|| ApiError::not_found("Milestone not found"))?;
    if m.project_id != access.project.id {
        return Err(ApiError::not_found("Milestone not found"));
    }
    if let Some(n) = body.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 120 {
            return Err(ApiError::unprocessable("name must be 1..120 chars"));
        }
        m.name = trimmed;
    }
    if let Some(d) = body.description {
        m.description = d.chars().take(1000).collect();
    }
    if let Some(s) = body.start_date {
        m.start_date = s;
    }
    if let Some(t) = body.target_date {
        m.target_date = t;
    }
    if let (Some(s), Some(t)) = (m.start_date, m.target_date) {
        if s > t {
            return Err(ApiError::unprocessable("start_date must be on or before target_date"));
        }
    }
    if let Some(st) = body.status {
        validate_status(&st)?;
        m.status = st;
    }
    m.updated_at = utcnow();
    state.db.milestones.update(&m)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "milestone.updated",
        json!({ "milestone_id": m.id }),
    );
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    Ok(Json(build_milestone_read(m, &all_tasks)))
}

async fn delete_milestone(
    State(state): State<AppState>,
    Path((project_id, milestone_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let m = state
        .db
        .milestones
        .get(&milestone_id)?
        .ok_or_else(|| ApiError::not_found("Milestone not found"))?;
    if m.project_id != access.project.id {
        return Err(ApiError::not_found("Milestone not found"));
    }
    let now = utcnow();
    for mut t in state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.milestone_id.as_deref() == Some(&m.id))
    {
        t.milestone_id = None;
        t.updated_at = now;
        state.db.tasks.update(&t)?;
    }
    state.db.milestones.delete(&m.id)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "milestone.deleted",
        "milestone",
        &m.id,
        format!("마일스톤 '{}' 삭제", m.name),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "milestone.updated",
        json!({ "milestone_id": m.id }),
    );
    Ok(StatusCode::NO_CONTENT)
}
