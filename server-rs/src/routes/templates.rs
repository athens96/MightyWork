use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};

use crate::error::{ApiError, ApiResult};
use crate::models::{new_id, utcnow, Permission, TaskTemplate, TaskTemplateCreate, TaskTemplateUpdate};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/task-templates",
            get(list_templates).post(create_template),
        )
        .route(
            "/projects/{project_id}/task-templates/{template_id}",
            patch(update_template).delete(delete_template),
        )
}

async fn list_templates(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<TaskTemplate>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut items = state.db.task_templates.list_by_project(&access.project.id)?;
    items.sort_by_key(|t| t.created_at);
    Ok(Json(items))
}

async fn create_template(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskTemplateCreate>,
) -> ApiResult<(StatusCode, Json<TaskTemplate>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::unprocessable("name must be 1..100 chars"));
    }
    let now = utcnow();
    let tpl = TaskTemplate {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id,
        name,
        title_prefix: body.title_prefix.chars().take(40).collect(),
        description: body.description.chars().take(20000).collect(),
        stage: body.stage,
        priority: body.priority,
        tags: body
            .tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(30)
            .collect(),
        checklist: body
            .checklist
            .into_iter()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .take(50)
            .collect(),
        created_by: user.id,
    };
    state.db.task_templates.create(&tpl)?;
    Ok((StatusCode::CREATED, Json(tpl)))
}

async fn update_template(
    State(state): State<AppState>,
    Path((project_id, template_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<TaskTemplateUpdate>,
) -> ApiResult<Json<TaskTemplate>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut tpl = state
        .db
        .task_templates
        .get(&template_id)?
        .ok_or_else(|| ApiError::not_found("Template not found"))?;
    if tpl.project_id != access.project.id {
        return Err(ApiError::not_found("Template not found"));
    }
    if let Some(n) = body.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 100 {
            return Err(ApiError::unprocessable("name must be 1..100 chars"));
        }
        tpl.name = trimmed;
    }
    if let Some(p) = body.title_prefix {
        tpl.title_prefix = p.chars().take(40).collect();
    }
    if let Some(d) = body.description {
        tpl.description = d.chars().take(20000).collect();
    }
    if let Some(s) = body.stage {
        tpl.stage = s;
    }
    if let Some(pr) = body.priority {
        tpl.priority = pr;
    }
    if let Some(tags) = body.tags {
        tpl.tags = tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(30)
            .collect();
    }
    if let Some(cl) = body.checklist {
        tpl.checklist = cl
            .into_iter()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .take(50)
            .collect();
    }
    tpl.updated_at = utcnow();
    state.db.task_templates.update(&tpl)?;
    Ok(Json(tpl))
}

async fn delete_template(
    State(state): State<AppState>,
    Path((project_id, template_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let tpl = state
        .db
        .task_templates
        .get(&template_id)?
        .ok_or_else(|| ApiError::not_found("Template not found"))?;
    if tpl.project_id != access.project.id {
        return Err(ApiError::not_found("Template not found"));
    }
    state.db.task_templates.delete(&tpl.id)?;
    Ok(StatusCode::NO_CONTENT)
}
