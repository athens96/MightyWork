use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use serde_json::json;

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, utcnow, Cycle, CycleBurndownPoint, CycleCompleteRequest, CycleCompleteResult,
    CycleCreate, CycleRead, CycleUpdate, Permission, PipelineStage, Task,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::events::publish_event;
use crate::services::tasks::record_changes;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/cycles",
            get(list_cycles).post(create_cycle),
        )
        .route(
            "/projects/{project_id}/cycles/{cycle_id}",
            patch(update_cycle).delete(delete_cycle),
        )
        .route(
            "/projects/{project_id}/cycles/{cycle_id}/complete",
            post(complete_cycle),
        )
}

fn status_rank(s: &str) -> u8 {
    match s {
        "active" => 0,
        "upcoming" => 1,
        "completed" => 2,
        _ => 9,
    }
}

fn validate_cycle_status(s: &str) -> ApiResult<()> {
    if !matches!(s, "upcoming" | "active" | "completed") {
        return Err(ApiError::unprocessable("status must be upcoming, active, or completed"));
    }
    Ok(())
}

fn done_dates(db: &Database, project_id: &str, task_ids: &HashSet<String>) -> ApiResult<HashMap<String, NaiveDate>> {
    let mut done_at: HashMap<String, NaiveDate> = HashMap::new();
    if task_ids.is_empty() {
        return Ok(done_at);
    }
    for act in db.task_activities.list_by_project(project_id)? {
        if task_ids.contains(&act.task_id)
            && act.field.as_deref() == Some("stage")
            && act.new.as_str() == Some(PipelineStage::Done.as_str())
        {
            let d = act.created_at.date_naive();
            done_at
                .entry(act.task_id)
                .and_modify(|prev| {
                    if d > *prev {
                        *prev = d;
                    }
                })
                .or_insert(d);
        }
    }
    Ok(done_at)
}

pub fn build_cycle_read(db: &Database, cycle: Cycle, all_tasks: &[Task]) -> ApiResult<CycleRead> {
    let items: Vec<&Task> = all_tasks
        .iter()
        .filter(|t| t.cycle_id.as_deref() == Some(&cycle.id))
        .collect();
    let total_tasks = items.len();
    let done_items: Vec<&Task> = items
        .iter()
        .copied()
        .filter(|t| t.stage == PipelineStage::Done)
        .collect();
    let done_tasks = done_items.len();
    let total_points: i64 = items.iter().map(|t| t.estimate.unwrap_or(0)).sum();
    let done_points: i64 = done_items.iter().map(|t| t.estimate.unwrap_or(0)).sum();

    let use_points = total_points > 0;
    let scope = if use_points {
        total_points as f64
    } else {
        total_tasks as f64
    };
    let completion_pct = if total_points > 0 {
        ((done_points as f64 / total_points as f64) * 100.0).round() as i64
    } else if total_tasks > 0 {
        ((done_tasks as f64 / total_tasks as f64) * 100.0).round() as i64
    } else {
        0
    };

    let span = (cycle.end_date - cycle.start_date).num_days().max(0);
    let step = if span <= 21 { 1 } else { (span / 14).max(1) };
    let mut days = Vec::new();
    let mut cur = cycle.start_date;
    while cur < cycle.end_date {
        days.push(cur);
        cur += Duration::days(step);
    }
    days.push(cycle.end_date);

    let done_ids: HashSet<String> = done_items.iter().map(|t| t.id.clone()).collect();
    let done_map = done_dates(db, &cycle.project_id, &done_ids)?;
    let today = Utc::now().date_naive();
    let n_slots = (days.len().saturating_sub(1)).max(1) as f64;
    let mut burndown = Vec::with_capacity(days.len());

    for (idx, d) in days.iter().enumerate() {
        let ideal = if days.len() > 1 {
            ((scope * (1.0 - idx as f64 / n_slots)) * 10.0).round() / 10.0
        } else {
            0.0
        };
        let remaining = if *d > today && cycle.status != "completed" {
            None
        } else {
            let mut burned = 0.0;
            for t in &done_items {
                let finished_on = done_map
                    .get(&t.id)
                    .copied()
                    .unwrap_or_else(|| t.updated_at.date_naive());
                if finished_on <= *d {
                    burned += if use_points {
                        t.estimate.unwrap_or(0) as f64
                    } else {
                        1.0
                    };
                }
            }
            Some(((scope - burned).max(0.0) * 10.0).round() / 10.0)
        };
        burndown.push(CycleBurndownPoint {
            day: d.format("%Y-%m-%d").to_string(),
            ideal,
            remaining,
        });
    }

    Ok(CycleRead {
        cycle,
        total_tasks,
        done_tasks,
        total_points,
        done_points,
        completion_pct,
        burndown,
    })
}

fn get_cycle_or_404(db: &Database, project_id: &str, cycle_id: &str) -> ApiResult<Cycle> {
    let cycle = db
        .cycles
        .get(cycle_id)?
        .ok_or_else(|| ApiError::not_found("Cycle not found"))?;
    if cycle.project_id != project_id {
        return Err(ApiError::not_found("Cycle not found"));
    }
    Ok(cycle)
}

async fn list_cycles(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<CycleRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut cycles = state.db.cycles.list_by_project(&access.project.id)?;
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    cycles.sort_by(|a, b| {
        status_rank(&a.status).cmp(&status_rank(&b.status)).then_with(|| {
            if a.status == "completed" {
                b.end_date.cmp(&a.end_date)
            } else {
                a.start_date.cmp(&b.start_date)
            }
        })
    });
    let mut out = Vec::with_capacity(cycles.len());
    for c in cycles {
        out.push(build_cycle_read(&state.db, c, &all_tasks)?);
    }
    Ok(Json(out))
}

async fn create_cycle(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<CycleCreate>,
) -> ApiResult<(StatusCode, Json<CycleRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    validate_cycle_status(&body.status)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::unprocessable("name must be 1..120 chars"));
    }
    if body.start_date > body.end_date {
        return Err(ApiError::unprocessable("start_date must be on or before end_date"));
    }
    if let Some(tp) = body.target_points {
        if !(0..=10000).contains(&tp) {
            return Err(ApiError::unprocessable("target_points must be 0..=10000"));
        }
    }
    let now = utcnow();
    let cycle = Cycle {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        name,
        goal: body.goal.chars().take(500).collect(),
        start_date: body.start_date,
        end_date: body.end_date,
        target_points: body.target_points,
        status: body.status,
        created_by: user.id.clone(),
    };
    state.db.cycles.create(&cycle)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "cycle.created",
        "cycle",
        &cycle.id,
        format!(
            "사이클 '{}' 생성 ({} ~ {})",
            cycle.name, cycle.start_date, cycle.end_date
        ),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "cycle.updated",
        json!({ "cycle_id": cycle.id }),
    );
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    Ok((StatusCode::CREATED, Json(build_cycle_read(&state.db, cycle, &all_tasks)?)))
}

async fn update_cycle(
    State(state): State<AppState>,
    Path((project_id, cycle_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<CycleUpdate>,
) -> ApiResult<Json<CycleRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut cycle = get_cycle_or_404(&state.db, &access.project.id, &cycle_id)?;
    if let Some(n) = body.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 120 {
            return Err(ApiError::unprocessable("name must be 1..120 chars"));
        }
        cycle.name = trimmed;
    }
    if let Some(g) = body.goal {
        cycle.goal = g.chars().take(500).collect();
    }
    if let Some(sd) = body.start_date {
        cycle.start_date = sd;
    }
    if let Some(ed) = body.end_date {
        cycle.end_date = ed;
    }
    if cycle.start_date > cycle.end_date {
        return Err(ApiError::unprocessable("start_date must be on or before end_date"));
    }
    if let Some(tp) = body.target_points {
        if let Some(v) = tp {
            if !(0..=10000).contains(&v) {
                return Err(ApiError::unprocessable("target_points must be 0..=10000"));
            }
        }
        cycle.target_points = tp;
    }
    if let Some(st) = body.status {
        validate_cycle_status(&st)?;
        cycle.status = st;
    }
    cycle.updated_at = utcnow();
    state.db.cycles.update(&cycle)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "cycle.updated",
        json!({ "cycle_id": cycle.id }),
    );
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    Ok(Json(build_cycle_read(&state.db, cycle, &all_tasks)?))
}

async fn delete_cycle(
    State(state): State<AppState>,
    Path((project_id, cycle_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let cycle = get_cycle_or_404(&state.db, &access.project.id, &cycle_id)?;
    let now = utcnow();
    for mut t in state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.cycle_id.as_deref() == Some(&cycle.id))
    {
        t.cycle_id = None;
        t.updated_at = now;
        state.db.tasks.update(&t)?;
    }
    state.db.cycles.delete(&cycle.id)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "cycle.deleted",
        "cycle",
        &cycle.id,
        format!("사이클 '{}' 삭제", cycle.name),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "cycle.updated",
        json!({ "cycle_id": cycle.id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn complete_cycle(
    State(state): State<AppState>,
    Path((project_id, cycle_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<CycleCompleteRequest>,
) -> ApiResult<Json<CycleCompleteResult>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut cycle = get_cycle_or_404(&state.db, &access.project.id, &cycle_id)?;
    cycle.status = "completed".into();
    cycle.updated_at = utcnow();
    state.db.cycles.update(&cycle)?;

    let incomplete: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| {
            t.deleted_at.is_none()
                && t.cycle_id.as_deref() == Some(&cycle.id)
                && t.stage != PipelineStage::Done
        })
        .collect();

    let mut next_cycle: Option<Cycle> = None;
    let mut rolled = 0usize;

    if body.rollover && (!incomplete.is_empty() || body.next_cycle_id.is_some()) {
        let mut target = if let Some(ref ncid) = body.next_cycle_id {
            let nc = get_cycle_or_404(&state.db, &access.project.id, ncid)?;
            if nc.id == cycle.id {
                return Err(ApiError::bad_request("Cannot roll over into the same cycle"));
            }
            nc
        } else {
            let mut upcoming: Vec<Cycle> = state
                .db
                .cycles
                .list_by_project(&access.project.id)?
                .into_iter()
                .filter(|c| c.id != cycle.id && c.status == "upcoming")
                .collect();
            upcoming.sort_by_key(|c| c.start_date);
            if let Some(first) = upcoming.into_iter().next() {
                first
            } else {
                let duration = (cycle.end_date - cycle.start_date).num_days().max(1);
                let next_start = cycle.end_date + Duration::days(1);
                let next_end = next_start + Duration::days(duration);
                let seq = state.db.cycles.list_by_project(&access.project.id)?.len() + 1;
                let now = utcnow();
                let created = Cycle {
                    id: new_id(),
                    created_at: now,
                    updated_at: now,
                    project_id: access.project.id.clone(),
                    name: format!("Cycle {seq}"),
                    goal: String::new(),
                    start_date: next_start,
                    end_date: next_end,
                    target_points: cycle.target_points,
                    status: "active".into(),
                    created_by: user.id.clone(),
                };
                state.db.cycles.create(&created)?;
                created
            }
        };

        if target.status == "upcoming" {
            target.status = "active".into();
            target.updated_at = utcnow();
            state.db.cycles.update(&target)?;
        }

        for t in incomplete {
            let mut moved = t.clone();
            moved.cycle_id = Some(target.id.clone());
            moved.updated_at = utcnow();
            state.db.tasks.update(&moved)?;
            record_changes(&state.db, &t, &moved, &user.id, None);
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "task.updated",
                json!({ "task_id": moved.id, "stage": moved.stage.as_str() }),
            );
            rolled += 1;
        }
        next_cycle = Some(target);
    }

    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "cycle.completed",
        "cycle",
        &cycle.id,
        format!("사이클 '{}' 완료 (미완료 {rolled}건 이월)", cycle.name),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "cycle.updated",
        json!({ "cycle_id": cycle.id }),
    );

    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();

    Ok(Json(CycleCompleteResult {
        completed: build_cycle_read(&state.db, cycle, &all_tasks)?,
        next_cycle: match next_cycle {
            Some(nc) => Some(build_cycle_read(&state.db, nc, &all_tasks)?),
            None => None,
        },
        rolled_over_count: rolled,
    }))
}
