use axum::extract::{FromRequestParts, Request};
use axum::http::header::{self, HeaderValue};
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;

use crate::error::{ApiError, ApiResult};
use crate::models::{Permission, Task, User};
use crate::security::decode_access_token;
use crate::services::access::{resolve_access, Access};
use crate::AppState;

/// Authorization: Bearer <jwt> (또는 SSE/파일 다운로드용 ?token=<jwt>) 추출
#[derive(Debug, Clone)]
pub struct AuthUser(pub User);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")))
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let token = match token {
            Some(t) => t,
            None => return Err(ApiError::unauthorized("Not authenticated")),
        };

        let user_id = decode_access_token(token, &state.settings)
            .map_err(|_| ApiError::unauthorized("Not authenticated"))?;
        let user = state
            .db
            .users
            .get(&user_id)?
            .ok_or_else(|| ApiError::unauthorized("Not authenticated"))?;
        Ok(AuthUser(user))
    }
}

pub fn require_project_access(state: &AppState, project_id: &str, user: &User) -> ApiResult<Access> {
    let project = state
        .db
        .projects
        .get(project_id)?
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    let access = resolve_access(&state.db, &project, user)?;
    if !access.can(Permission::View) {
        return Err(ApiError::not_found("Project not found"));
    }
    Ok(access)
}

pub fn require_perm(access: &Access, perm: Permission) -> ApiResult<()> {
    if !access.can(perm) {
        return Err(ApiError::forbidden(format!("'{}' permission required", perm.as_str())));
    }
    Ok(())
}

pub fn require_active_task(state: &AppState, project_id: &str, task_id: &str) -> ApiResult<Task> {
    let task = state
        .db
        .tasks
        .get(task_id)?
        .ok_or_else(|| ApiError::not_found("Task not found"))?;
    if task.project_id != project_id || task.deleted_at.is_some() {
        return Err(ApiError::not_found("Task not found"));
    }
    Ok(task)
}

pub fn extract_cookie(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    for val in headers.get_all(header::COOKIE) {
        if let Ok(s) = val.to_str() {
            for part in s.split(';') {
                let mut kv = part.trim().splitn(2, '=');
                if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
                    if k.trim() == name {
                        return Some(v.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers
        .entry("x-content-type-options")
        .or_insert_with(|| HeaderValue::from_static("nosniff"));
    headers
        .entry("referrer-policy")
        .or_insert_with(|| HeaderValue::from_static("strict-origin-when-cross-origin"));
    headers
        .entry("x-frame-options")
        .or_insert_with(|| HeaderValue::from_static("DENY"));
    res
}
