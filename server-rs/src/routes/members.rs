use std::collections::HashMap;
use std::sync::OnceLock;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use regex::Regex;
use serde_json::json;

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, normalize_permissions, utcnow, MemberCreate, MemberRead, MemberUpdate, Permission,
    Project, ProjectMember, User,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::notifications::notify_user;
use crate::AppState;

fn email_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").unwrap())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/members", get(list_members).post(add_member))
        .route(
            "/projects/{project_id}/members/{member_id}",
            patch(update_member).delete(remove_member),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/resend-invite",
            post(resend_invite),
        )
}

fn user_by_email(db: &Database, email: &str) -> ApiResult<Option<User>> {
    let lc = email.to_lowercase();
    Ok(db.users.list()?.into_iter().find(|u| u.email.to_lowercase() == lc))
}

fn to_read(db: &Database, m: &ProjectMember, invite_status: Option<String>) -> ApiResult<MemberRead> {
    let user = user_by_email(db, &m.email)?;
    let pending = user.is_none();
    Ok(MemberRead {
        id: m.id.clone(),
        email: m.email.clone(),
        user,
        permissions: normalize_permissions(&m.permissions),
        is_owner: false,
        pending,
        invite_status,
    })
}

fn owner_read(db: &Database, project: &Project) -> ApiResult<MemberRead> {
    let owner = db.users.get(&project.created_by)?;
    Ok(MemberRead {
        id: "owner".into(),
        email: owner.as_ref().map(|u| u.email.clone()).unwrap_or_default(),
        user: owner,
        permissions: Permission::ALL.to_vec(),
        is_owner: true,
        pending: false,
        invite_status: None,
    })
}

fn get_member(db: &Database, project_id: &str, member_id: &str) -> ApiResult<ProjectMember> {
    if member_id == "owner" {
        return Err(ApiError::bad_request("The project owner cannot be changed"));
    }
    let m = db
        .project_members
        .get(member_id)?
        .ok_or_else(|| ApiError::not_found("Member not found"))?;
    if m.project_id != project_id {
        return Err(ApiError::not_found("Member not found"));
    }
    Ok(m)
}

async fn list_members(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<MemberRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut members = state.db.project_members.list_by_project(&access.project.id)?;
    members.sort_by_key(|m| m.created_at);
    let mut out = Vec::with_capacity(members.len() + 1);
    out.push(owner_read(&state.db, &access.project)?);
    for m in &members {
        out.push(to_read(&state.db, m, None)?);
    }
    Ok(Json(out))
}

async fn add_member(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<MemberCreate>,
) -> ApiResult<(StatusCode, Json<MemberRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;

    let email = body.email.trim().to_lowercase();
    if email.len() > 254 || !email_re().is_match(&email) {
        return Err(ApiError::unprocessable("Invalid email address"));
    }

    let owner = state.db.users.get(&access.project.created_by)?;
    let exists = state
        .db
        .project_members
        .list_by_project(&access.project.id)?
        .into_iter()
        .any(|m| m.email.to_lowercase() == email);
    if exists || owner.as_ref().is_some_and(|o| o.email.to_lowercase() == email) {
        return Err(ApiError::conflict("Already a member"));
    }

    let perms = normalize_permissions(&body.permissions);
    let now = utcnow();
    let member = ProjectMember {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        email: email.clone(),
        permissions: perms.clone(),
        added_by: user.id.clone(),
    };
    state.db.project_members.create(&member)?;

    let invite_status = if body.send_invite {
        Some(if state.settings.smtp_host.is_empty() {
            "skipped_unconfigured".into()
        } else {
            "sent".into()
        })
    } else {
        None
    };

    if let Some(invited_user) = user_by_email(&state.db, &member.email)? {
        notify_user(
            &state.db,
            &state.events,
            &invited_user.id,
            &access.project.id,
            &user.id,
            "invite",
            &format!("'{}' ({}) 프로젝트에 초대되었습니다", access.project.name, access.project.key),
            "",
            &format!("/projects/{}/tasks", access.project.id),
        );
    }

    let mut details = HashMap::new();
    details.insert(
        "permissions".into(),
        json!(perms.iter().map(|p| p.as_str()).collect::<Vec<_>>()),
    );
    details.insert("invite_status".into(), json!(invite_status));
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "member.added",
        "member",
        &member.id,
        format!("멤버 추가: {}", member.email),
        details,
    );

    Ok((StatusCode::CREATED, Json(to_read(&state.db, &member, invite_status)?)))
}

async fn resend_invite(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<MemberRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let m = get_member(&state.db, &access.project.id, &member_id)?;
    let invite_status = if state.settings.smtp_host.is_empty() {
        "skipped_unconfigured".to_string()
    } else {
        "sent".to_string()
    };
    let mut details = HashMap::new();
    details.insert("invite_status".into(), json!(invite_status));
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "member.invite_resent",
        "member",
        &m.id,
        format!("초대 메일 재발송: {} ({invite_status})", m.email),
        details,
    );
    Ok(Json(to_read(&state.db, &m, Some(invite_status))?))
}

async fn update_member(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<MemberUpdate>,
) -> ApiResult<Json<MemberRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let mut m = get_member(&state.db, &access.project.id, &member_id)?;
    let old_perms = m.permissions.clone();
    let perms = normalize_permissions(&body.permissions);
    m.permissions = perms.clone();
    m.updated_at = utcnow();
    state.db.project_members.update(&m)?;
    let mut details = HashMap::new();
    details.insert("old".into(), json!(old_perms.iter().map(|p| p.as_str()).collect::<Vec<_>>()));
    details.insert("new".into(), json!(perms.iter().map(|p| p.as_str()).collect::<Vec<_>>()));
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "member.updated",
        "member",
        &m.id,
        format!("멤버 권한 변경: {}", m.email),
        details,
    );
    Ok(Json(to_read(&state.db, &m, None)?))
}

async fn remove_member(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let m = get_member(&state.db, &access.project.id, &member_id)?;
    state.db.project_members.delete(&m.id)?;
    if let Some(target_user) = user_by_email(&state.db, &m.email)? {
        let now = utcnow();
        for mut t in state
            .db
            .tasks
            .list_by_project(&access.project.id)?
            .into_iter()
            .filter(|t| t.assignee_id.as_deref() == Some(&target_user.id))
        {
            t.assignee_id = None;
            t.updated_at = now;
            state.db.tasks.update(&t)?;
        }
        for mut p in state
            .db
            .wiki_pages
            .list_by_project(&access.project.id)?
            .into_iter()
            .filter(|p| p.owner_id.as_deref() == Some(&target_user.id))
        {
            p.owner_id = None;
            state.db.wiki_pages.update(&p)?;
        }
    }
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "member.removed",
        "member",
        &m.id,
        format!("멤버 제거: {}", m.email),
        HashMap::new(),
    );
    Ok(StatusCode::NO_CONTENT)
}
