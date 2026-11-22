use std::collections::HashMap;
use std::sync::OnceLock;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;

use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, utcnow, AuditLog, OwnershipTransferRequest, Permission, Project, ProjectCreate,
    ProjectMember, ProjectRead, ProjectUpdate,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::access::{accessible_projects, find_member, Access};
use crate::services::audit::record_audit;
use crate::services::notifications::notify_user;
use crate::services::tasks::delete_project_cascade;
use crate::AppState;

fn project_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9]{1,9}$").unwrap())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{project_id}",
            get(get_project).patch(update_project).delete(delete_project),
        )
        .route("/projects/{project_id}/transfer-ownership", post(transfer_ownership))
        .route("/projects/{project_id}/audit-logs", get(list_audit_logs))
}

fn to_read(access: &Access, project: Option<Project>) -> ProjectRead {
    ProjectRead {
        project: project.unwrap_or_else(|| access.project.clone()),
        my_permissions: access.permissions.clone(),
        is_owner: access.is_owner,
    }
}

async fn list_projects(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Vec<ProjectRead>>> {
    let mut list = accessible_projects(&state.db, &user)?;
    list.sort_by_key(|a| a.project.created_at);
    Ok(Json(list.iter().map(|a| to_read(a, None)).collect()))
}

async fn create_project(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<ProjectCreate>,
) -> ApiResult<(StatusCode, Json<ProjectRead>)> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::unprocessable("Project name must be 1..100 characters"));
    }
    let key = body.key.trim().to_uppercase();
    if !project_key_re().is_match(&key) {
        return Err(ApiError::unprocessable(
            "Project key must start with uppercase letter and be 2..10 alphanumeric chars",
        ));
    }

    let existing = state.db.projects.list_where(|p| p.key == key)?;
    if !existing.is_empty() {
        return Err(ApiError::conflict(format!("Project key '{key}' already exists")));
    }

    let now = utcnow();
    let project = Project {
        id: new_id(),
        created_at: now,
        updated_at: now,
        name,
        description: body.description,
        key: key.clone(),
        created_by: user.id.clone(),
        task_seq: 0,
    };
    state.db.projects.create(&project)?;
    record_audit(
        &state.db,
        &project.id,
        &user.id,
        "project.created",
        "project",
        &project.id,
        format!("프로젝트 '{}' ({}) 생성", project.name, project.key),
        HashMap::new(),
    );
    let access = Access {
        project: project.clone(),
        user,
        permissions: Permission::ALL.to_vec(),
        is_owner: true,
    };
    Ok((StatusCode::CREATED, Json(to_read(&access, Some(project)))))
}

async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<ProjectRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    Ok(Json(to_read(&access, None)))
}

async fn update_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<ProjectUpdate>,
) -> ApiResult<Json<ProjectRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let mut latest = state.db.projects.get(&access.project.id)?.unwrap_or_else(|| access.project.clone());
    if let Some(name) = body.name {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 100 {
            return Err(ApiError::unprocessable("Project name must be 1..100 characters"));
        }
        latest.name = trimmed;
    }
    if let Some(desc) = body.description {
        latest.description = desc;
    }
    latest.updated_at = utcnow();
    state.db.projects.update(&latest)?;
    record_audit(
        &state.db,
        &latest.id,
        &user.id,
        "project.updated",
        "project",
        &latest.id,
        format!("프로젝트 정보 수정: {}", latest.name),
        HashMap::new(),
    );
    Ok(Json(to_read(&access, Some(latest))))
}

async fn transfer_ownership(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<OwnershipTransferRequest>,
) -> ApiResult<Json<ProjectRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    if !access.is_owner {
        return Err(ApiError::forbidden("Only the project owner can transfer ownership"));
    }
    if body.new_owner_user_id == user.id {
        return Err(ApiError::bad_request("You are already the project owner"));
    }
    let target_user = state
        .db
        .users
        .get(&body.new_owner_user_id)?
        .ok_or_else(|| ApiError::not_found("Target user not found"))?;

    let mut latest = state
        .db
        .projects
        .get(&access.project.id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    let target_member = find_member(&state.db, &latest.id, &target_user.email)?
        .ok_or_else(|| ApiError::bad_request("New owner must be an existing project member"))?;

    state.db.project_members.delete(&target_member.id)?;
    if find_member(&state.db, &latest.id, &user.email)?.is_none() {
        let now = utcnow();
        state.db.project_members.create(&ProjectMember {
            id: new_id(),
            created_at: now,
            updated_at: now,
            project_id: latest.id.clone(),
            email: user.email.to_lowercase(),
            permissions: Permission::ALL.to_vec(),
            added_by: target_user.id.clone(),
        })?;
    }

    latest.created_by = target_user.id.clone();
    latest.updated_at = utcnow();
    state.db.projects.update(&latest)?;

    notify_user(
        &state.db,
        &state.events,
        &target_user.id,
        &latest.id,
        &user.id,
        "ownership",
        &format!("'{}' ({}) 프로젝트의 소유권을 넘겨받았습니다", latest.name, latest.key),
        "",
        &format!("/projects/{}/members", latest.id),
    );
    let mut details = HashMap::new();
    details.insert("from_user_id".into(), json!(user.id));
    details.insert("to_user_id".into(), json!(target_user.id));
    record_audit(
        &state.db,
        &latest.id,
        &user.id,
        "project.ownership_transferred",
        "project",
        &latest.id,
        format!("소유권 이전: {} → {}", user.email, target_user.email),
        details,
    );
    let next_access = Access {
        project: latest.clone(),
        user,
        permissions: Permission::ALL.to_vec(),
        is_owner: false,
    };
    Ok(Json(to_read(&next_access, Some(latest))))
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    action: Option<String>,
    limit: Option<usize>,
}

async fn list_audit_logs(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<AuditQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<AuditLog>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let mut logs: Vec<AuditLog> = state
        .db
        .audit_logs
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|a| match &q.action {
            None => true,
            Some(act) => a.action == *act || a.action.starts_with(&format!("{act}.")),
        })
        .collect();
    logs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    logs.truncate(limit);
    Ok(Json(logs))
}

async fn delete_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    if !access.is_owner {
        return Err(ApiError::forbidden("Only the project owner can delete the project"));
    }
    delete_project_cascade(&state.db, &access.project.id)?;
    Ok(StatusCode::NO_CONTENT)
}
