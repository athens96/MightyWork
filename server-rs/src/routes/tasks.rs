use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    clean_version, default_pipeline_stages, deserialize_double_option, new_id, utcnow,
    ChecklistItem, MyTaskRead, Permission, PipelineStage, PipelineStageInfo, Priority, Project,
    ProjectPipeline, ProjectPipelineUpdate, Task, TaskCreate, TaskLink, TaskLinkCreate,
    TaskLinkKind, TaskLinkRead, TaskRead, TaskUpdate,
};
use crate::routes::deps::{require_active_task, require_perm, require_project_access, AuthUser};
use crate::services::access::{accessible_projects, is_member_user, resolve_access};
use crate::services::audit::record_audit;
use crate::services::events::publish_event;
use crate::services::links::{link_targets, norm_title, pages_by_title, project_pages};
use crate::services::notifications::{notify_mentions, notify_user};
use crate::services::tasks::{delete_task_cascade, record_changes, record_created, soft_delete_task};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/pipeline", get(get_pipeline))
        .route(
            "/projects/{project_id}/pipeline",
            get(get_project_pipeline).put(update_project_pipeline),
        )
        .route("/my/tasks", get(list_my_tasks))
        .route("/projects/{project_id}/tasks", get(list_tasks).post(create_task))
        .route("/projects/{project_id}/tasks/bulk", post(bulk_update_tasks))
        .route(
            "/projects/{project_id}/tasks/{task_id}",
            get(get_task).patch(update_task).delete(delete_task),
        )
        .route("/projects/{project_id}/tasks/{task_id}/watch", post(toggle_watch_task))
        .route("/projects/{project_id}/tasks/{task_id}/duplicate", post(duplicate_task))
        .route("/projects/{project_id}/tasks/{task_id}/move", post(move_task_to_project))
        .route("/projects/{project_id}/tasks/{task_id}/subtasks", get(list_subtasks))
        .route(
            "/projects/{project_id}/tasks/{task_id}/links",
            get(list_task_links).post(create_task_link),
        )
        .route(
            "/projects/{project_id}/tasks/{task_id}/links/{link_id}",
            delete(delete_task_link),
        )
        .route(
            "/projects/{project_id}/tasks/{task_id}/wiki-links",
            get(task_outgoing_wiki_links),
        )
}

fn project_pipeline_stages(db: &Database, project_id: &str) -> ApiResult<Vec<PipelineStageInfo>> {
    let found = db.project_pipelines.list_by_project(project_id)?;
    let Some(first) = found.into_iter().next() else {
        return Ok(default_pipeline_stages());
    };
    let mut stages = first.stages;
    let present: HashSet<PipelineStage> = stages.iter().map(|s| s.key).collect();
    for s in PipelineStage::ALL {
        if !present.contains(&s) {
            stages.push(PipelineStageInfo {
                key: s,
                label: s.label().into(),
                color: String::new(),
                hidden: true,
                wip_limit: None,
            });
        }
    }
    Ok(stages)
}

async fn get_pipeline(AuthUser(_): AuthUser) -> Json<Vec<PipelineStageInfo>> {
    Json(default_pipeline_stages())
}

async fn get_project_pipeline(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<PipelineStageInfo>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    Ok(Json(project_pipeline_stages(&state.db, &access.project.id)?))
}

async fn update_project_pipeline(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<ProjectPipelineUpdate>,
) -> ApiResult<Json<Vec<PipelineStageInfo>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    if body.stages.is_empty() || body.stages.len() > 6 {
        return Err(ApiError::unprocessable("stages must have 1..6 entries"));
    }

    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for mut st in body.stages {
        if !seen.insert(st.key) {
            return Err(ApiError::bad_request(format!("Duplicate stage: {}", st.key.as_str())));
        }
        let trimmed = st.label.trim().to_string();
        st.label = if trimmed.is_empty() {
            st.key.label().into()
        } else {
            trimmed
        };
        normalized.push(st);
    }
    for s in PipelineStage::ALL {
        if !seen.contains(&s) {
            normalized.push(PipelineStageInfo {
                key: s,
                label: s.label().into(),
                color: String::new(),
                hidden: true,
                wip_limit: None,
            });
        }
    }

    let visible: Vec<PipelineStage> = normalized.iter().filter(|s| !s.hidden).map(|s| s.key).collect();
    if visible.is_empty() {
        return Err(ApiError::bad_request("At least one pipeline stage must remain visible"));
    }
    let hidden_keys: HashSet<PipelineStage> = normalized.iter().filter(|s| s.hidden).map(|s| s.key).collect();
    let fallback = body
        .remap_hidden_to
        .filter(|k| visible.contains(k))
        .unwrap_or(visible[0]);

    let mut remapped = 0usize;
    if !hidden_keys.is_empty() {
        for t in state
            .db
            .tasks
            .list_by_project(&access.project.id)?
            .into_iter()
            .filter(|x| x.deleted_at.is_none() && hidden_keys.contains(&x.stage))
        {
            let mut moved = t.clone();
            moved.stage = fallback;
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
            remapped += 1;
        }
    }

    let existing = state.db.project_pipelines.list_by_project(&access.project.id)?;
    let now = utcnow();
    if let Some(mut first) = existing.into_iter().next() {
        first.stages = normalized.clone();
        first.updated_at = now;
        state.db.project_pipelines.update(&first)?;
    } else {
        state.db.project_pipelines.create(&ProjectPipeline {
            id: new_id(),
            created_at: now,
            updated_at: now,
            project_id: access.project.id.clone(),
            stages: normalized.clone(),
        })?;
    }

    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "project.pipeline_updated",
        "project",
        &access.project.id,
        format!("파이프라인 설정 변경 (표시 {}단계, 일감 매핑 {remapped}건)", visible.len()),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "pipeline.updated",
        json!({ "project_id": access.project.id }),
    );
    Ok(Json(normalized))
}

fn ensure_assignee_is_member(db: &Database, project: &Project, assignee_id: Option<&str>) -> ApiResult<()> {
    if let Some(uid) = assignee_id {
        if !is_member_user(db, project, uid)? {
            return Err(ApiError::bad_request("Assignee must be a project member"));
        }
    }
    Ok(())
}

fn validate_parent(db: &Database, project_id: &str, task_id: Option<&str>, parent_id: Option<&str>) -> ApiResult<()> {
    let mut current = parent_id.map(str::to_string);
    while let Some(cur) = current {
        if task_id == Some(cur.as_str()) {
            return Err(ApiError::bad_request("Task cannot be nested under itself"));
        }
        let parent = db
            .tasks
            .get(&cur)?
            .ok_or_else(|| ApiError::bad_request("Parent task not found"))?;
        if parent.project_id != project_id || parent.deleted_at.is_some() {
            return Err(ApiError::bad_request("Parent task not found"));
        }
        current = parent.parent_id;
    }
    Ok(())
}

fn validate_cycle(db: &Database, project_id: &str, cycle_id: Option<&str>) -> ApiResult<()> {
    if let Some(cid) = cycle_id {
        let c = db.cycles.get(cid)?;
        if c.as_ref().map(|x| x.project_id.as_str()) != Some(project_id) {
            return Err(ApiError::bad_request("Cycle not found"));
        }
    }
    Ok(())
}

fn validate_milestone(db: &Database, project_id: &str, milestone_id: Option<&str>) -> ApiResult<()> {
    if let Some(mid) = milestone_id {
        let m = db.milestones.get(mid)?;
        if m.as_ref().map(|x| x.project_id.as_str()) != Some(project_id) {
            return Err(ApiError::bad_request("Milestone not found"));
        }
    }
    Ok(())
}

fn validate_dates(start_date: Option<NaiveDate>, due_date: Option<NaiveDate>) -> ApiResult<()> {
    if let (Some(s), Some(d)) = (start_date, due_date) {
        if s > d {
            return Err(ApiError::unprocessable("start_date must be on or before due_date"));
        }
    }
    Ok(())
}

pub fn build_task_read(
    db: &Database,
    task: Task,
    comment_count: Option<usize>,
    subtask_stats: Option<(usize, usize)>,
    blocked_by_count: Option<usize>,
) -> ApiResult<TaskRead> {
    let comment_count = match comment_count {
        Some(n) => n,
        None => db
            .comments
            .list_by_project(&task.project_id)?
            .into_iter()
            .filter(|c| c.task_id == task.id)
            .count(),
    };
    let (subtask_count, subtask_done) = match subtask_stats {
        Some(pair) => pair,
        None => {
            let subs: Vec<Task> = db
                .tasks
                .list_by_project(&task.project_id)?
                .into_iter()
                .filter(|t| t.parent_id.as_deref() == Some(&task.id) && t.deleted_at.is_none())
                .collect();
            let done = subs.iter().filter(|s| s.stage == PipelineStage::Done).count();
            (subs.len(), done)
        }
    };
    let blocked_by_count = match blocked_by_count {
        Some(n) => n,
        None => {
            let mut count = 0usize;
            for l in db
                .task_links
                .list_by_project(&task.project_id)?
                .into_iter()
                .filter(|l| l.target_id == task.id && l.kind == TaskLinkKind::Blocks)
            {
                if let Some(src) = db.tasks.get(&l.source_id)? {
                    if src.deleted_at.is_none() && src.stage != PipelineStage::Done {
                        count += 1;
                    }
                }
            }
            count
        }
    };
    Ok(TaskRead {
        task,
        comment_count,
        subtask_count,
        subtask_done,
        blocked_by_count,
    })
}

#[derive(Debug, Deserialize)]
struct MyTasksQuery {
    #[serde(default = "default_scope")]
    scope: String,
    #[serde(default)]
    due_soon: bool,
    #[serde(default)]
    include_done: bool,
    stage: Option<PipelineStage>,
}

fn default_scope() -> String {
    "assigned".into()
}

async fn list_my_tasks(
    State(state): State<AppState>,
    Query(q): Query<MyTasksQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<MyTaskRead>>> {
    let projects_by_id: HashMap<String, Project> = accessible_projects(&state.db, &user)?
        .into_iter()
        .map(|a| (a.project.id.clone(), a.project))
        .collect();
    if projects_by_id.is_empty() {
        return Ok(Json(vec![]));
    }
    let cutoff = (Utc::now() + Duration::days(2)).date_naive();
    let all_tasks: Vec<Task> = state
        .db
        .tasks
        .list()?
        .into_iter()
        .filter(|t| {
            projects_by_id.contains_key(&t.project_id) && t.deleted_at.is_none() && t.triage_status.is_none()
        })
        .collect();

    let mut sub_counts: HashMap<String, (usize, usize)> = HashMap::new();
    for t in &all_tasks {
        if let Some(pid) = &t.parent_id {
            let entry = sub_counts.entry(pid.clone()).or_insert((0, 0));
            entry.0 += 1;
            if t.stage == PipelineStage::Done {
                entry.1 += 1;
            }
        }
    }
    let mut comment_counts: HashMap<String, usize> = HashMap::new();
    for c in state.db.comments.list()? {
        if projects_by_id.contains_key(&c.project_id) {
            *comment_counts.entry(c.task_id).or_insert(0) += 1;
        }
    }
    let tasks_by_id: HashMap<&str, &Task> = all_tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut blocked_counts: HashMap<String, usize> = HashMap::new();
    for l in state.db.task_links.list()? {
        if projects_by_id.contains_key(&l.project_id) && l.kind == TaskLinkKind::Blocks {
            if let Some(src) = tasks_by_id.get(l.source_id.as_str()) {
                if src.stage != PipelineStage::Done {
                    *blocked_counts.entry(l.target_id).or_insert(0) += 1;
                }
            }
        }
    }

    let mut picked = Vec::new();
    for t in &all_tasks {
        if q.scope == "assigned" && t.assignee_id.as_deref() != Some(&user.id) {
            continue;
        }
        if q.scope == "created" && t.created_by != user.id {
            continue;
        }
        if q.scope == "all" && t.assignee_id.as_deref() != Some(&user.id) && t.created_by != user.id {
            continue;
        }
        if q.stage.is_some() && q.stage != Some(t.stage) {
            continue;
        }
        if !q.include_done && q.stage != Some(PipelineStage::Done) && t.stage == PipelineStage::Done {
            continue;
        }
        if q.due_soon && (t.due_date.is_none() || t.due_date.unwrap() > cutoff || t.stage == PipelineStage::Done) {
            continue;
        }
        let p = &projects_by_id[&t.project_id];
        let base = build_task_read(
            &state.db,
            t.clone(),
            Some(*comment_counts.get(&t.id).unwrap_or(&0)),
            Some(*sub_counts.get(&t.id).unwrap_or(&(0, 0))),
            Some(*blocked_counts.get(&t.id).unwrap_or(&0)),
        )?;
        picked.push(MyTaskRead {
            base,
            project_key: p.key.clone(),
            project_name: p.name.clone(),
        });
    }

    picked.sort_by(|a, b| {
        let ka = (
            a.base.task.stage == PipelineStage::Done,
            a.base.task.due_date.is_none(),
            a.base.task.due_date.unwrap_or(NaiveDate::MAX),
            a.base.task.priority.rank(),
            std::cmp::Reverse(a.base.task.updated_at),
        );
        let kb = (
            b.base.task.stage == PipelineStage::Done,
            b.base.task.due_date.is_none(),
            b.base.task.due_date.unwrap_or(NaiveDate::MAX),
            b.base.task.priority.rank(),
            std::cmp::Reverse(b.base.task.updated_at),
        );
        ka.cmp(&kb)
    });

    Ok(Json(picked))
}

#[derive(Debug, Deserialize)]
struct ListTasksQuery {
    stage: Option<PipelineStage>,
    assignee_id: Option<String>,
    parent_id: Option<String>,
    cycle_id: Option<String>,
    milestone_id: Option<String>,
    version: Option<String>,
    #[serde(default)]
    include_triage: bool,
}

async fn list_tasks(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<ListTasksQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TaskRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let all_project_tasks: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none() && (q.include_triage || t.triage_status.is_none()))
        .collect();

    let mut sub_counts: HashMap<String, (usize, usize)> = HashMap::new();
    for t in &all_project_tasks {
        if let Some(pid) = &t.parent_id {
            let pair = sub_counts.entry(pid.clone()).or_insert((0, 0));
            pair.0 += 1;
            if t.stage == PipelineStage::Done {
                pair.1 += 1;
            }
        }
    }
    let by_id: HashMap<&str, &Task> = all_project_tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut blocked_counts: HashMap<String, usize> = HashMap::new();
    for l in state.db.task_links.list_by_project(&access.project.id)? {
        if l.kind == TaskLinkKind::Blocks {
            if let Some(src) = by_id.get(l.source_id.as_str()) {
                if src.stage != PipelineStage::Done {
                    *blocked_counts.entry(l.target_id).or_insert(0) += 1;
                }
            }
        }
    }
    let mut comment_counts: HashMap<String, usize> = HashMap::new();
    for c in state.db.comments.list_by_project(&access.project.id)? {
        *comment_counts.entry(c.task_id).or_insert(0) += 1;
    }

    let ver_cf = q.version.as_deref().map(|v| v.trim().to_lowercase());
    let mut filtered: Vec<Task> = all_project_tasks
        .into_iter()
        .filter(|t| {
            (q.stage.is_none() || q.stage == Some(t.stage))
                && (q.assignee_id.is_none() || t.assignee_id == q.assignee_id)
                && (q.parent_id.is_none() || t.parent_id == q.parent_id)
                && (q.cycle_id.is_none() || t.cycle_id == q.cycle_id)
                && (q.milestone_id.is_none() || t.milestone_id == q.milestone_id)
                && (ver_cf.is_none()
                    || t.version.as_deref().unwrap_or("").to_lowercase() == ver_cf.as_deref().unwrap())
        })
        .collect();
    filtered.sort_by_key(|t| t.number);

    let mut out = Vec::with_capacity(filtered.len());
    for t in filtered {
        let cc = *comment_counts.get(&t.id).unwrap_or(&0);
        let sc = *sub_counts.get(&t.id).unwrap_or(&(0, 0));
        let bc = *blocked_counts.get(&t.id).unwrap_or(&0);
        out.push(build_task_read(&state.db, t, Some(cc), Some(sc), Some(bc))?);
    }
    Ok(Json(out))
}

async fn create_task(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskCreate>,
) -> ApiResult<(StatusCode, Json<TaskRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let title = body.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::unprocessable("title must be 1..200 chars"));
    }
    validate_dates(body.start_date, body.due_date)?;
    if let Some(est) = body.estimate {
        if !(0..=100).contains(&est) {
            return Err(ApiError::unprocessable("estimate must be 0..=100"));
        }
    }
    ensure_assignee_is_member(&state.db, &access.project, body.assignee_id.as_deref())?;
    validate_parent(&state.db, &access.project.id, None, body.parent_id.as_deref())?;
    validate_cycle(&state.db, &access.project.id, body.cycle_id.as_deref())?;
    validate_milestone(&state.db, &access.project.id, body.milestone_id.as_deref())?;

    let number = state
        .db
        .allocate_task_number(&access.project.id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    let now = utcnow();
    let task = Task {
        id: new_id(),
        created_at: now,
        updated_at: now,
        title,
        description: body.description,
        stage: body.stage,
        priority: body.priority,
        parent_id: body.parent_id,
        cycle_id: body.cycle_id,
        milestone_id: body.milestone_id,
        version: clean_version(body.version),
        assignee_id: body.assignee_id,
        tags: body.tags,
        start_date: body.start_date,
        due_date: body.due_date,
        estimate: body.estimate,
        checklist: body.checklist,
        triage_status: None,
        triage_snooze_until: None,
        triage_source: String::new(),
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

    let link = format!("/projects/{}/tasks/{}", access.project.id, task.id);
    let key = format!("{}-{}", access.project.key, task.number);
    if let Some(aid) = &task.assignee_id {
        notify_user(
            &state.db,
            &state.events,
            aid,
            &access.project.id,
            &user.id,
            "assigned",
            &format!("{key} '{}' 일감이 배정되었습니다", task.title),
            "",
            &link,
        );
    }
    notify_mentions(
        &state.db,
        &state.events,
        &access.project,
        &user,
        &task.description,
        &format!("{key} '{}' 설명에서 나를 언급했습니다", task.title),
        &link,
    );
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "task.created",
        "task",
        &task.id,
        format!("{key} {} 생성", task.title),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "task.created",
        json!({ "task_id": task.id, "stage": task.stage.as_str() }),
    );
    Ok((
        StatusCode::CREATED,
        Json(build_task_read(&state.db, task, Some(0), Some((0, 0)), Some(0))?),
    ))
}

#[derive(Debug, Deserialize)]
struct TaskBulkRequest {
    task_ids: Vec<String>,
    stage: Option<PipelineStage>,
    priority: Option<Priority>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    assignee_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    cycle_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    milestone_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    version: Option<Option<String>>,
    add_tags: Option<Vec<String>>,
    remove_tags: Option<Vec<String>>,
    #[serde(default)]
    delete: bool,
}

#[derive(Debug, Serialize)]
struct TaskBulkResult {
    affected: usize,
    tasks: Vec<TaskRead>,
}

async fn bulk_update_tasks(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskBulkRequest>,
) -> ApiResult<Json<TaskBulkResult>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let need = if body.delete { Permission::Delete } else { Permission::Edit };
    require_perm(&access, need)?;
    if body.task_ids.is_empty() || body.task_ids.len() > 200 {
        return Err(ApiError::unprocessable("task_ids must have 1..200 items"));
    }
    if let Some(ref aid) = body.assignee_id {
        ensure_assignee_is_member(&state.db, &access.project, aid.as_deref())?;
    }
    if let Some(ref cid) = body.cycle_id {
        validate_cycle(&state.db, &access.project.id, cid.as_deref())?;
    }
    if let Some(ref mid) = body.milestone_id {
        validate_milestone(&state.db, &access.project.id, mid.as_deref())?;
    }

    let mut seen = HashSet::new();
    let mut updated_reads = Vec::new();
    let mut affected = 0usize;

    for tid in body.task_ids {
        if !seen.insert(tid.clone()) {
            continue;
        }
        let Some(task) = state.db.tasks.get(&tid)? else {
            continue;
        };
        if task.project_id != access.project.id || task.deleted_at.is_some() {
            continue;
        }
        if body.delete {
            soft_delete_task(&state.db, &task, &user.id)?;
            publish_event(
                &state.db,
                &state.events,
                &access.project.id,
                "task.deleted",
                json!({ "task_id": task.id }),
            );
            affected += 1;
            continue;
        }

        let mut updated = task.clone();
        let mut changed = false;
        if let Some(st) = body.stage {
            updated.stage = st;
            changed = true;
        }
        if let Some(pr) = body.priority {
            updated.priority = pr;
            changed = true;
        }
        if let Some(ref aid) = body.assignee_id {
            updated.assignee_id = aid.clone();
            changed = true;
        }
        if let Some(ref cid) = body.cycle_id {
            updated.cycle_id = cid.clone();
            changed = true;
        }
        if let Some(ref mid) = body.milestone_id {
            updated.milestone_id = mid.clone();
            changed = true;
        }
        if let Some(ref ver) = body.version {
            updated.version = clean_version(ver.clone());
            changed = true;
        }
        if body.add_tags.is_some() || body.remove_tags.is_some() {
            let mut tags = updated.tags.clone();
            if let Some(ref rm) = body.remove_tags {
                let rm_set: HashSet<&str> = rm.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
                tags.retain(|t| !rm_set.contains(t.as_str()));
            }
            if let Some(ref add) = body.add_tags {
                for t in add {
                    let clean = t.trim();
                    if !clean.is_empty() && !tags.iter().any(|x| x == clean) {
                        tags.push(clean.to_string());
                    }
                }
            }
            updated.tags = tags;
            changed = true;
        }
        if !changed {
            continue;
        }
        updated.updated_at = utcnow();
        state.db.tasks.update(&updated)?;
        record_changes(&state.db, &task, &updated, &user.id, None);
        publish_event(
            &state.db,
            &state.events,
            &access.project.id,
            "task.updated",
            json!({ "task_id": updated.id, "stage": updated.stage.as_str() }),
        );
        updated_reads.push(build_task_read(&state.db, updated, None, None, None)?);
        affected += 1;
    }

    if affected > 0 {
        record_audit(
            &state.db,
            &access.project.id,
            &user.id,
            if body.delete { "task.bulk_deleted" } else { "task.bulk_updated" },
            "project",
            &access.project.id,
            format!("일감 {affected}건 일괄 {}", if body.delete { "삭제" } else { "편집" }),
            HashMap::new(),
        );
    }

    Ok(Json(TaskBulkResult {
        affected,
        tasks: updated_reads,
    }))
}

async fn get_task(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<TaskRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    Ok(Json(build_task_read(&state.db, task, None, None, None)?))
}

async fn update_task(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskUpdate>,
) -> ApiResult<Json<TaskRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;

    let mut updated = task.clone();
    if let Some(title_opt) = body.title {
        let Some(title) = title_opt else {
            return Err(ApiError::unprocessable("title cannot be null"));
        };
        if title.is_empty() || title.chars().count() > 200 {
            return Err(ApiError::unprocessable("title must be 1..200 chars"));
        }
        updated.title = title;
    }
    if let Some(Some(desc)) = body.description {
        updated.description = desc;
    }
    if let Some(stage_opt) = body.stage {
        let Some(stage) = stage_opt else {
            return Err(ApiError::unprocessable("stage cannot be null"));
        };
        updated.stage = stage;
    }
    if let Some(prio_opt) = body.priority {
        let Some(prio) = prio_opt else {
            return Err(ApiError::unprocessable("priority cannot be null"));
        };
        updated.priority = prio;
    }
    if let Some(parent_opt) = body.parent_id {
        validate_parent(&state.db, &access.project.id, Some(&task.id), parent_opt.as_deref())?;
        updated.parent_id = parent_opt;
    }
    if let Some(cycle_opt) = body.cycle_id {
        validate_cycle(&state.db, &access.project.id, cycle_opt.as_deref())?;
        updated.cycle_id = cycle_opt;
    }
    if let Some(ms_opt) = body.milestone_id {
        validate_milestone(&state.db, &access.project.id, ms_opt.as_deref())?;
        updated.milestone_id = ms_opt;
    }
    if let Some(ver_opt) = body.version {
        updated.version = clean_version(ver_opt);
    }
    if let Some(assignee_opt) = body.assignee_id {
        ensure_assignee_is_member(&state.db, &access.project, assignee_opt.as_deref())?;
        updated.assignee_id = assignee_opt;
    }
    if let Some(Some(tags)) = body.tags {
        updated.tags = tags;
    }
    if let Some(sd) = body.start_date {
        updated.start_date = sd;
    }
    if let Some(dd) = body.due_date {
        updated.due_date = dd;
    }
    if let Some(est) = body.estimate {
        if let Some(v) = est {
            if !(0..=100).contains(&v) {
                return Err(ApiError::unprocessable("estimate must be 0..=100"));
            }
        }
        updated.estimate = est;
    }
    if let Some(Some(cl)) = body.checklist {
        updated.checklist = cl;
    }

    validate_dates(updated.start_date, updated.due_date)?;
    updated.updated_at = utcnow();
    state.db.tasks.update(&updated)?;
    record_changes(&state.db, &task, &updated, &user.id, None);

    let link = format!("/projects/{}/tasks/{}", access.project.id, updated.id);
    let key = format!("{}-{}", access.project.key, updated.number);

    if updated.assignee_id.is_some() && updated.assignee_id != task.assignee_id {
        if let Some(aid) = &updated.assignee_id {
            notify_user(
                &state.db,
                &state.events,
                aid,
                &access.project.id,
                &user.id,
                "assigned",
                &format!("{key} '{}' 일감이 배정되었습니다", updated.title),
                "",
                &link,
            );
        }
    }
    if !updated.watcher_ids.is_empty()
        && (updated.stage != task.stage || updated.assignee_id != task.assignee_id || updated.due_date != task.due_date)
    {
        let already = if updated.assignee_id != task.assignee_id {
            updated.assignee_id.as_deref()
        } else {
            None
        };
        let reason = if updated.stage != task.stage {
            format!("단계가 '{}'(으)로 변경되었습니다", updated.stage.label())
        } else {
            "속성이 변경되었습니다".into()
        };
        for wid in &updated.watcher_ids {
            if Some(wid.as_str()) != already {
                notify_user(
                    &state.db,
                    &state.events,
                    wid,
                    &access.project.id,
                    &user.id,
                    "watched",
                    &format!("[구독] {key} '{}' {reason}", updated.title),
                    "",
                    &link,
                );
            }
        }
    }
    if updated.description != task.description {
        notify_mentions(
            &state.db,
            &state.events,
            &access.project,
            &user,
            &updated.description,
            &format!("{key} '{}' 설명에서 나를 언급했습니다", updated.title),
            &link,
        );
    }
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "task.updated",
        json!({ "task_id": updated.id, "stage": updated.stage.as_str() }),
    );
    Ok(Json(build_task_read(&state.db, updated, None, None, None)?))
}

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    permanent: bool,
}

async fn delete_task(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    Query(q): Query<DeleteQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let key = format!("{}-{}", access.project.key, task.number);
    let summary = if q.permanent {
        delete_task_cascade(&state.db, &access.project.id, &task.id)?;
        format!("{key} {} 영구 삭제", task.title)
    } else {
        soft_delete_task(&state.db, &task, &user.id)?;
        format!("{key} {} 휴지통 이동", task.title)
    };
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        if q.permanent { "task.deleted" } else { "task.trashed" },
        "task",
        &task.id,
        summary,
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "task.deleted",
        json!({ "task_id": task.id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn toggle_watch_task(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<TaskRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut task = require_active_task(&state, &access.project.id, &task_id)?;
    if let Some(pos) = task.watcher_ids.iter().position(|w| w == &user.id) {
        task.watcher_ids.remove(pos);
    } else {
        task.watcher_ids.push(user.id.clone());
    }
    state.db.tasks.update(&task)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "task.updated",
        json!({ "task_id": task.id }),
    );
    Ok(Json(build_task_read(&state.db, task, None, None, None)?))
}

async fn duplicate_task(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<(StatusCode, Json<TaskRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let number = state
        .db
        .allocate_task_number(&access.project.id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    let suffix = " (복사)";
    let title: String = if task.title.chars().count() + suffix.chars().count() > 200 {
        let base: String = task.title.chars().take(200 - suffix.chars().count()).collect();
        format!("{base}{suffix}")
    } else {
        format!("{}{suffix}", task.title)
    };
    let now = utcnow();
    let copy = Task {
        id: new_id(),
        created_at: now,
        updated_at: now,
        title,
        description: task.description.clone(),
        stage: task.stage,
        priority: task.priority,
        parent_id: task.parent_id.clone(),
        cycle_id: task.cycle_id.clone(),
        milestone_id: task.milestone_id.clone(),
        version: task.version.clone(),
        assignee_id: task.assignee_id.clone(),
        tags: task.tags.clone(),
        start_date: task.start_date,
        due_date: task.due_date,
        estimate: task.estimate,
        checklist: task
            .checklist
            .iter()
            .map(|i| ChecklistItem {
                id: new_id(),
                text: i.text.clone(),
                done: false,
            })
            .collect(),
        triage_status: None,
        triage_snooze_until: None,
        triage_source: String::new(),
        project_id: access.project.id.clone(),
        number,
        created_by: user.id.clone(),
        watcher_ids: vec![],
        deleted_at: None,
        deleted_by: None,
        via_client: None,
    };
    state.db.tasks.create(&copy)?;
    record_created(&state.db, &copy, &user.id, None);
    let src_key = format!("{}-{}", access.project.key, task.number);
    let dst_key = format!("{}-{}", access.project.key, copy.number);
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "task.duplicated",
        "task",
        &copy.id,
        format!("{src_key} → {dst_key} 복제"),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "task.created",
        json!({ "task_id": copy.id, "stage": copy.stage.as_str() }),
    );
    Ok((
        StatusCode::CREATED,
        Json(build_task_read(&state.db, copy, Some(0), Some((0, 0)), Some(0))?),
    ))
}

#[derive(Debug, Deserialize)]
struct TaskMoveRequest {
    target_project_id: String,
}

async fn move_task_to_project(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskMoveRequest>,
) -> ApiResult<Json<TaskRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    if body.target_project_id == access.project.id {
        return Err(ApiError::bad_request("Target project must be different"));
    }
    let target = state
        .db
        .projects
        .get(&body.target_project_id)?
        .ok_or_else(|| ApiError::not_found("Target project not found"))?;
    let target_access = resolve_access(&state.db, &target, &user)?;
    if !target_access.can(Permission::View) {
        return Err(ApiError::not_found("Target project not found"));
    }
    if !target_access.can(Permission::Create) {
        return Err(ApiError::forbidden("'create' permission required on target project"));
    }

    let old_key = format!("{}-{}", access.project.key, task.number);
    let new_number = state
        .db
        .allocate_task_number(&target.id)?
        .ok_or_else(|| ApiError::not_found("Target project not found"))?;
    let keep_assignee = match &task.assignee_id {
        Some(aid) if is_member_user(&state.db, &target, aid)? => Some(aid.clone()),
        _ => None,
    };

    let mut moved = task.clone();
    moved.project_id = target.id.clone();
    moved.number = new_number;
    moved.parent_id = None;
    moved.cycle_id = None;
    moved.milestone_id = None;
    moved.assignee_id = keep_assignee;
    moved.updated_at = utcnow();
    state.db.tasks.update(&moved)?;

    for mut c in state
        .db
        .comments
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.task_id == task.id)
    {
        c.project_id = target.id.clone();
        state.db.comments.update(&c)?;
    }
    for mut a in state
        .db
        .task_activities
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.task_id == task.id)
    {
        a.project_id = target.id.clone();
        state.db.task_activities.update(&a)?;
    }
    for mut att in state.db.attachments.list_by_project(&access.project.id)? {
        if att.task_id.as_deref() == Some(&task.id) {
            att.project_id = target.id.clone();
            state.db.attachments.update(&att)?;
        }
    }
    for l in state
        .db
        .task_links
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|l| l.source_id == task.id || l.target_id == task.id)
    {
        state.db.task_links.delete(&l.id)?;
    }
    for mut child in state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|x| x.parent_id.as_deref() == Some(&task.id))
    {
        child.parent_id = None;
        state.db.tasks.update(&child)?;
    }

    let new_key = format!("{}-{}", target.key, moved.number);
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "task.moved_out",
        "task",
        &moved.id,
        format!("{old_key} → {new_key} ({}) 이동", target.name),
        HashMap::new(),
    );
    record_audit(
        &state.db,
        &target.id,
        &user.id,
        "task.moved_in",
        "task",
        &moved.id,
        format!("{old_key} ({}) → {new_key} 이동됨", access.project.name),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "task.deleted",
        json!({ "task_id": moved.id }),
    );
    publish_event(
        &state.db,
        &state.events,
        &target.id,
        "task.created",
        json!({ "task_id": moved.id, "stage": moved.stage.as_str() }),
    );
    Ok(Json(build_task_read(&state.db, moved, None, None, None)?))
}

async fn list_subtasks(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TaskRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut subs: Vec<Task> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.parent_id.as_deref() == Some(&task.id) && t.deleted_at.is_none())
        .collect();
    subs.sort_by_key(|t| t.number);
    let mut out = Vec::with_capacity(subs.len());
    for s in subs {
        out.push(build_task_read(&state.db, s, None, None, None)?);
    }
    Ok(Json(out))
}

async fn list_task_links(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TaskLinkRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut links: Vec<TaskLink> = state
        .db
        .task_links
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|l| l.source_id == task.id || l.target_id == task.id)
        .collect();
    links.sort_by_key(|l| l.created_at);
    let mut out = Vec::new();
    for l in links {
        let is_src = l.source_id == task.id;
        let other_id = if is_src { &l.target_id } else { &l.source_id };
        let Some(other) = state.db.tasks.get(other_id)? else {
            continue;
        };
        if other.deleted_at.is_some() {
            continue;
        }
        let kind = if is_src {
            l.kind.as_str()
        } else {
            l.kind.reverse_str()
        };
        out.push(TaskLinkRead {
            id: l.id,
            kind: kind.to_string(),
            task_id: other.id,
            number: other.number,
            title: other.title,
            stage: other.stage,
        });
    }
    Ok(Json(out))
}

async fn create_task_link(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskLinkCreate>,
) -> ApiResult<(StatusCode, Json<TaskLinkRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    if body.target_id == task.id {
        return Err(ApiError::bad_request("Cannot link a task to itself"));
    }
    let target = state
        .db
        .tasks
        .get(&body.target_id)?
        .ok_or_else(|| ApiError::not_found("Target task not found"))?;
    if target.project_id != access.project.id || target.deleted_at.is_some() {
        return Err(ApiError::not_found("Target task not found"));
    }

    for l in state.db.task_links.list_by_project(&access.project.id)? {
        let same_dir = l.source_id == task.id && l.target_id == target.id && l.kind == body.kind;
        let sym_dup = body.kind == TaskLinkKind::RelatesTo
            && l.kind == TaskLinkKind::RelatesTo
            && l.source_id == target.id
            && l.target_id == task.id;
        if same_dir || sym_dup {
            return Err(ApiError::conflict("Task link already exists"));
        }
    }

    let now = utcnow();
    let created = TaskLink {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        source_id: task.id.clone(),
        target_id: target.id.clone(),
        kind: body.kind,
        created_by: user.id.clone(),
    };
    state.db.task_links.create(&created)?;
    if body.kind == TaskLinkKind::Blocks {
        publish_event(
            &state.db,
            &state.events,
            &access.project.id,
            "task.updated",
            json!({ "task_id": target.id }),
        );
    }
    Ok((
        StatusCode::CREATED,
        Json(TaskLinkRead {
            id: created.id,
            kind: created.kind.as_str().into(),
            task_id: target.id,
            number: target.number,
            title: target.title,
            stage: target.stage,
        }),
    ))
}

async fn delete_task_link(
    State(state): State<AppState>,
    Path((project_id, task_id, link_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let link = state
        .db
        .task_links
        .get(&link_id)?
        .ok_or_else(|| ApiError::not_found("Task link not found"))?;
    if link.project_id != access.project.id || (link.source_id != task.id && link.target_id != task.id) {
        return Err(ApiError::not_found("Task link not found"));
    }
    state.db.task_links.delete(&link.id)?;
    if link.kind == TaskLinkKind::Blocks {
        publish_event(
            &state.db,
            &state.events,
            &access.project.id,
            "task.updated",
            json!({ "task_id": link.target_id }),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn task_outgoing_wiki_links(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<Value>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let pages = project_pages(&state.db, &access.project.id)?;
    let by_title = pages_by_title(&pages);
    let out = link_targets(&task.description)
        .into_iter()
        .map(|title| {
            let pid = by_title.get(&norm_title(&title)).map(|p| p.id.clone());
            json!({ "title": title, "page_id": pid })
        })
        .collect();
    Ok(Json(out))
}
