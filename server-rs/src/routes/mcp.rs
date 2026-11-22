use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::NaiveDate;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::config::APP_VERSION;
use crate::db::Database;
use crate::models::{
    clean_string_list, clean_version, new_id, utcnow, ChecklistItem, Comment, Cycle, Milestone,
    PageStatus, PageType, Permission, PipelineStage, Priority, Project, Task, TaskLink,
    TaskLinkKind, User, WikiPage, SCOPE_READ, SCOPE_WRITE,
};
use crate::services::access::{accessible_projects, is_member_user, resolve_access, Access};
use crate::services::events::publish_event;
use crate::services::knowledge_qa::answer_question;
use crate::services::links::{norm_title, pages_by_title, project_pages, propagate_rename};
use crate::services::oauth::{self, McpTokenClaims};
use crate::services::releases::{build_changelog, build_releases};
use crate::services::search::search_project;
use crate::services::tasks::{record_changes, record_created};
use crate::services::wiki_revisions::record_revision;
use crate::AppState;

const INSTRUCTIONS: &str = "MightyWork 는 프로젝트별 일감(파이프라인 보드)과 위키(Markdown)를 관리하는 협업 도구입니다.\n\
- 먼저 list_projects 로 접근 가능한 프로젝트와 키(예: MW)를 확인하세요. project 인자에는 키나 id 를 씁니다.\n\
- 일감은 'MW-12' 같은 키로 가리킵니다. 단계: backlog → todo → in_progress → review → qa → done.\n\
- 버전(version)·사이클(cycle)·마일스톤(milestone)은 태그가 아닌 전용 필드와 도구(list_cycles, list_milestones, list_releases)를 사용하세요.\n\
- 위키 본문의 [[페이지 제목]] 은 다른 위키 페이지 링크, MW-12 는 일감 링크입니다.\n\
- 쓰기 도구는 토큰에 쓰기 권한(mightywork:write)이 있고 프로젝트 권한(생성/편집)이 있을 때만 동작합니다.";

pub fn router() -> Router<AppState> {
    Router::new().route("/mcp", get(mcp_get).post(mcp_post).delete(mcp_delete))
}

fn unauthorized_mcp(state: &AppState) -> Response {
    let prm = format!("{}/.well-known/oauth-protected-resource/mcp", state.settings.base_url());
    let mut res = (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "invalid_token", "error_description": "Authentication required" })),
    )
        .into_response();
    if let Ok(hv) = HeaderValue::from_str(&format!(
        r#"Bearer resource_metadata="{prm}", scope="{SCOPE_READ} {SCOPE_WRITE}""#
    )) {
        res.headers_mut().insert(header::WWW_AUTHENTICATE, hv);
    }
    res
}

fn authenticate_mcp(state: &AppState, headers: &HeaderMap) -> Result<McpTokenClaims, Response> {
    let tok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| unauthorized_mcp(state))?;
    let claims = oauth::verify_access_token(&state.settings, &state.db, tok)
        .ok_or_else(|| unauthorized_mcp(state))?;
    if !claims.scope.split_whitespace().any(|s| s == SCOPE_READ) {
        return Err(unauthorized_mcp(state));
    }
    Ok(claims)
}

async fn mcp_get(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(resp) = authenticate_mcp(&state, &headers) {
        return resp;
    }
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(8);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tx.closed() => break,
                _ = tokio::time::sleep(Duration::from_secs(20)) => {
                    if tx.send(Ok(Event::default().comment("keepalive"))).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let sse = Sse::new(ReceiverStream::new(rx));
    (
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            (HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no")),
        ],
        sse,
    )
        .into_response()
}

async fn mcp_delete(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(resp) = authenticate_mcp(&state, &headers) {
        return resp;
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn mcp_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let claims = match authenticate_mcp(&state, &headers) {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                })),
            )
                .into_response();
        }
    };

    let existing_session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if let Some(arr) = parsed.as_array() {
        let mut responses = Vec::new();
        let mut new_session: Option<String> = None;
        for msg in arr {
            let (resp_opt, sess) = handle_rpc_message(&state, &claims, msg);
            if sess.is_some() {
                new_session = sess;
            }
            if let Some(r) = resp_opt {
                responses.push(r);
            }
        }
        if responses.is_empty() {
            return StatusCode::ACCEPTED.into_response();
        }
        let mut res = (StatusCode::OK, Json(Value::Array(responses))).into_response();
        if let Some(sid) = new_session.or(existing_session) {
            if let Ok(hv) = HeaderValue::from_str(&sid) {
                res.headers_mut()
                    .insert(HeaderName::from_static("mcp-session-id"), hv);
            }
        }
        return res;
    }

    let (resp_opt, new_session) = handle_rpc_message(&state, &claims, &parsed);
    let Some(resp_val) = resp_opt else {
        return StatusCode::ACCEPTED.into_response();
    };
    let mut res = (StatusCode::OK, Json(resp_val)).into_response();
    if let Some(sid) = new_session.or(existing_session) {
        if let Ok(hv) = HeaderValue::from_str(&sid) {
            res.headers_mut()
                .insert(HeaderName::from_static("mcp-session-id"), hv);
        }
    }
    res
}

fn handle_rpc_message(
    state: &AppState,
    claims: &McpTokenClaims,
    msg: &Value,
) -> (Option<Value>, Option<String>) {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    // Notifications (no id)
    if id.is_none() || method.starts_with("notifications/") {
        return (None, None);
    }
    let req_id = id.unwrap();

    match method {
        "initialize" => {
            let requested_ver = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-03-26");
            let protocol_version = match requested_ver {
                "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25" => requested_ver,
                _ => "2025-03-26",
            };
            let session_id = new_id();
            let result = json!({
                "protocolVersion": protocol_version,
                "capabilities": {
                    "tools": { "listChanged": false }
                },
                "serverInfo": {
                    "name": "MightyWork",
                    "version": APP_VERSION,
                    "websiteUrl": state.settings.app_url,
                    "icons": [{
                        "src": format!("{}/icon.png", state.settings.base_url()),
                        "mimeType": "image/png",
                        "sizes": ["192x192"]
                    }]
                },
                "instructions": INSTRUCTIONS
            });
            (
                Some(json!({ "jsonrpc": "2.0", "id": req_id, "result": result })),
                Some(session_id),
            )
        }
        "ping" => (
            Some(json!({ "jsonrpc": "2.0", "id": req_id, "result": {} })),
            None,
        ),
        "tools/list" => (
            Some(json!({ "jsonrpc": "2.0", "id": req_id, "result": { "tools": tool_definitions() } })),
            None,
        ),
        "tools/call" => {
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let call_res = dispatch_tool(state, claims, tool_name, &args);
            let result = match call_res {
                Ok(val) => {
                    let text = serde_json::to_string_pretty(&val).unwrap_or_else(|_| "{}".into());
                    json!({
                        "content": [{ "type": "text", "text": text }],
                        "isError": false
                    })
                }
                Err(msg) => json!({
                    "content": [{ "type": "text", "text": msg }],
                    "isError": true
                }),
            };
            (
                Some(json!({ "jsonrpc": "2.0", "id": req_id, "result": result })),
                None,
            )
        }
        _ => (
            Some(json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            })),
            None,
        ),
    }
}

// ---------------------------------------------------------------- Tool Helpers

struct McpCtx<'a> {
    state: &'a AppState,
    claims: &'a McpTokenClaims,
}

impl<'a> McpCtx<'a> {
    fn db(&self) -> &Database {
        &self.state.db
    }

    fn me(&self, write: bool) -> Result<User, String> {
        if write && !self.claims.scope.split_whitespace().any(|s| s == SCOPE_WRITE) {
            return Err("이 연결에는 쓰기 권한(mightywork:write)이 없습니다. 앱 연결을 다시 하면서 '쓰기 허용'을 선택하세요.".into());
        }
        self.db()
            .users
            .get(&self.claims.sub)
            .map_err(|_| "DB 오류".to_string())?
            .ok_or_else(|| "사용자를 찾을 수 없습니다".to_string())
    }

    fn actor_client(&self) -> Option<String> {
        if let Ok(Some(grant)) = self.db().oauth_grants.get(&self.claims.grant) {
            if !grant.client_name.is_empty() {
                return Some(grant.client_name);
            }
        }
        if !self.claims.client_id.is_empty() {
            Some(self.claims.client_id.clone())
        } else {
            Some("MCP".into())
        }
    }

    fn project_access(&self, user: &User, project_ref: &str, need: Permission) -> Result<Access, String> {
        let key = project_ref.trim();
        let found = self
            .db()
            .projects
            .list()
            .map_err(|_| "DB 오류".to_string())?
            .into_iter()
            .find(|p| p.id == key || p.key.to_lowercase() == key.to_lowercase());
        let access = match found {
            Some(p) => resolve_access(self.db(), &p, user).ok(),
            None => None,
        };
        let Some(access) = access else {
            return Err(format!("프로젝트 '{project_ref}' 를 찾을 수 없거나 접근 권한이 없습니다"));
        };
        if !access.can(Permission::View) {
            return Err(format!("프로젝트 '{project_ref}' 를 찾을 수 없거나 접근 권한이 없습니다"));
        }
        if !access.can(need) {
            return Err(format!(
                "프로젝트 '{}' 에 '{}' 권한이 없습니다",
                access.project.key,
                need.as_str()
            ));
        }
        Ok(access)
    }

    fn find_task(&self, p: &Project, task_ref: &str) -> Result<Task, String> {
        let r = task_ref.trim();
        let num_str = if let Some((prefix, n)) = r.rsplit_once('-') {
            if prefix.to_lowercase() != p.key.to_lowercase() {
                return Err(format!("일감 키 형식이 잘못되었습니다: {r} (예: {}-12)", p.key));
            }
            n
        } else {
            r
        };
        let num: i64 = num_str
            .parse()
            .map_err(|_| format!("일감 키 형식이 잘못되었습니다: {r} (예: {}-12)", p.key))?;
        self.db()
            .tasks
            .list_by_project(&p.id)
            .map_err(|_| "DB 오류".to_string())?
            .into_iter()
            .find(|t| t.deleted_at.is_none() && t.number == num)
            .ok_or_else(|| format!("일감 {}-{num} 을 찾을 수 없습니다", p.key))
    }

    fn find_page(&self, p: &Project, page_ref: &str) -> Result<WikiPage, String> {
        if let Ok(Some(pg)) = self.db().wiki_pages.get(page_ref) {
            if pg.project_id == p.id && pg.deleted_at.is_none() {
                return Ok(pg);
            }
        }
        let pages = project_pages(self.db(), &p.id).map_err(|_| "DB 오류".to_string())?;
        pages_by_title(&pages)
            .get(&norm_title(page_ref))
            .cloned()
            .ok_or_else(|| format!("위키 페이지 '{page_ref}' 를 찾을 수 없습니다 (제목·별칭·id)"))
    }

    fn user_by_email(&self, p: &Project, email: Option<&str>) -> Result<Option<String>, String> {
        let Some(em) = email.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        let found = self
            .db()
            .users
            .list()
            .map_err(|_| "DB 오류".to_string())?
            .into_iter()
            .find(|u| u.email.to_lowercase() == em.to_lowercase());
        let Some(u) = found else {
            return Err(format!("'{em}' 은 이 프로젝트의 (로그인한) 멤버가 아닙니다"));
        };
        if !is_member_user(self.db(), p, &u.id).unwrap_or(false) {
            return Err(format!("'{em}' 은 이 프로젝트의 (로그인한) 멤버가 아닙니다"));
        }
        Ok(Some(u.id))
    }

    fn find_cycle(&self, p: &Project, cycle_ref: &str) -> Result<Cycle, String> {
        let key = cycle_ref.trim();
        if let Ok(Some(c)) = self.db().cycles.get(key) {
            if c.project_id == p.id {
                return Ok(c);
            }
        }
        self.db()
            .cycles
            .list_by_project(&p.id)
            .map_err(|_| "DB 오류".to_string())?
            .into_iter()
            .find(|c| c.name.to_lowercase() == key.to_lowercase())
            .ok_or_else(|| format!("사이클 '{cycle_ref}' 를 찾을 수 없습니다 (이름 또는 id)"))
    }

    fn find_milestone(&self, p: &Project, ms_ref: &str) -> Result<Milestone, String> {
        let key = ms_ref.trim();
        if let Ok(Some(m)) = self.db().milestones.get(key) {
            if m.project_id == p.id {
                return Ok(m);
            }
        }
        self.db()
            .milestones
            .list_by_project(&p.id)
            .map_err(|_| "DB 오류".to_string())?
            .into_iter()
            .find(|m| m.name.to_lowercase() == key.to_lowercase())
            .ok_or_else(|| format!("마일스톤 '{ms_ref}' 를 찾을 수 없습니다 (이름 또는 id)"))
    }

    fn email_of(&self, uid: Option<&str>) -> Option<String> {
        uid.and_then(|id| self.db().users.get(id).ok().flatten())
            .map(|u| u.email)
    }

    fn cycle_name_of(&self, cid: Option<&str>) -> Option<String> {
        cid.and_then(|id| self.db().cycles.get(id).ok().flatten())
            .map(|c| c.name)
    }

    fn milestone_name_of(&self, mid: Option<&str>) -> Option<String> {
        mid.and_then(|id| self.db().milestones.get(id).ok().flatten())
            .map(|m| m.name)
    }

    fn task_summary(&self, p: &Project, t: &Task) -> Value {
        let checklist_str = if t.checklist.is_empty() {
            Value::Null
        } else {
            let done = t.checklist.iter().filter(|i| i.done).count();
            json!(format!("{done}/{}", t.checklist.len()))
        };
        json!({
            "key": format!("{}-{}", p.key, t.number),
            "title": t.title,
            "stage": t.stage.as_str(),
            "priority": t.priority,
            "version": t.version,
            "cycle": self.cycle_name_of(t.cycle_id.as_deref()),
            "milestone": self.milestone_name_of(t.milestone_id.as_deref()),
            "assignee": self.email_of(t.assignee_id.as_deref()),
            "due_date": t.due_date.map(|d| d.format("%Y-%m-%d").to_string()),
            "tags": t.tags,
            "checklist": checklist_str,
        })
    }

    fn task_detail(&self, p: &Project, t: &Task) -> Value {
        let mut comments: Vec<Comment> = self
            .db()
            .comments
            .list_by_project(&p.id)
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.task_id == t.id)
            .collect();
        comments.sort_by_key(|c| c.created_at);
        let comment_vals: Vec<Value> = comments
            .into_iter()
            .map(|c| {
                json!({
                    "author": self.email_of(Some(&c.author_id)),
                    "at": c.created_at.format("%Y-%m-%dT%H:%M+00:00").to_string(),
                    "body": c.body,
                })
            })
            .collect();
        let checklist_vals: Vec<Value> = t
            .checklist
            .iter()
            .map(|i| json!({ "text": i.text, "done": i.done }))
            .collect();
        let mut obj = self.task_summary(p, t);
        if let Some(m) = obj.as_object_mut() {
            m.insert("description".into(), json!(t.description));
            m.insert(
                "start_date".into(),
                json!(t.start_date.map(|d| d.format("%Y-%m-%d").to_string())),
            );
            m.insert("estimate".into(), json!(t.estimate));
            m.insert("checklist".into(), json!(checklist_vals));
            m.insert("reporter".into(), json!(self.email_of(Some(&t.created_by))));
            m.insert("comments".into(), json!(comment_vals));
            m.insert(
                "updated_at".into(),
                json!(t.updated_at.format("%Y-%m-%dT%H:%M+00:00").to_string()),
            );
            m.insert(
                "url".into(),
                json!(format!(
                    "{}/projects/{}/tasks/{}",
                    self.state.settings.app_url.trim_end_matches('/'),
                    p.id,
                    t.id
                )),
            );
        }
        obj
    }

    fn page_summary(&self, pg: &WikiPage) -> Value {
        json!({
            "id": pg.id,
            "title": pg.title,
            "aliases": pg.aliases,
            "type": pg.page_type.map(|x| x.as_str()),
            "status": pg.status.map(|x| x.as_str()),
            "tags": pg.tags,
            "parent_id": pg.parent_id,
            "updated_at": pg.updated_at.format("%Y-%m-%dT%H:%M+00:00").to_string(),
        })
    }
}

fn req_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("'{key}' 인자가 필요합니다"))
}

fn opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn opt_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn opt_date(args: &Value, key: &str) -> Result<Option<NaiveDate>, String> {
    let Some(s) = args.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(Some)
        .map_err(|_| format!("'{key}' 날짜 형식은 YYYY-MM-DD 여야 합니다"))
}

fn opt_str_list(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect()
    })
}

fn parse_stage(s: &str) -> Result<PipelineStage, String> {
    serde_json::from_value(json!(s)).map_err(|_| format!("잘못된 stage: {s}"))
}

fn parse_priority(s: &str) -> Result<Priority, String> {
    serde_json::from_value(json!(s)).map_err(|_| format!("잘못된 priority: {s}"))
}

fn dispatch_tool(state: &AppState, claims: &McpTokenClaims, name: &str, args: &Value) -> Result<Value, String> {
    let ctx = McpCtx { state, claims };
    match name {
        "list_projects" => {
            let user = ctx.me(false)?;
            let mut list = accessible_projects(ctx.db(), &user).map_err(|_| "DB 오류".to_string())?;
            list.sort_by_key(|a| a.project.created_at);
            Ok(json!(list
                .into_iter()
                .map(|a| json!({
                    "key": a.project.key,
                    "id": a.project.id,
                    "name": a.project.name,
                    "description": a.project.description,
                    "my_permissions": a.permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
                    "owner": a.is_owner,
                }))
                .collect::<Vec<_>>()))
        }
        "search" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let hits = search_project(ctx.db(), &a.project, req_str(args, "query")?, 20)
                .map_err(|_| "검색 오류".to_string())?;
            Ok(json!(hits
                .into_iter()
                .map(|h| {
                    let r = if h.kind == "task" {
                        format!("{}-{}", a.project.key, h.number.unwrap_or(0))
                    } else {
                        h.id
                    };
                    json!({ "kind": h.kind, "ref": r, "title": h.title, "snippet": h.snippet })
                })
                .collect::<Vec<_>>()))
        }
        "list_tasks" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let stage_f = match opt_str(args, "stage") {
                Some(s) => Some(parse_stage(s)?),
                None => None,
            };
            let ver_cf = opt_str(args, "version").map(|s| s.trim().to_lowercase());
            let cycle_id = match opt_str(args, "cycle") {
                Some(c) => Some(ctx.find_cycle(&a.project, c)?.id),
                None => None,
            };
            let milestone_id = match opt_str(args, "milestone") {
                Some(m) => Some(ctx.find_milestone(&a.project, m)?.id),
                None => None,
            };
            let assignee = if opt_bool(args, "mine") {
                Some(user.id.clone())
            } else {
                ctx.user_by_email(&a.project, opt_str(args, "assignee_email"))?
            };
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .clamp(1, 200) as usize;

            let mut tasks: Vec<Task> = ctx
                .db()
                .tasks
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .filter(|t| {
                    t.deleted_at.is_none()
                        && stage_f.is_none_or(|s| t.stage == s)
                        && ver_cf.as_deref().is_none_or(|v| {
                            t.version.as_deref().unwrap_or("").to_lowercase() == v
                        })
                        && cycle_id.as_deref().is_none_or(|c| t.cycle_id.as_deref() == Some(c))
                        && milestone_id
                            .as_deref()
                            .is_none_or(|m| t.milestone_id.as_deref() == Some(m))
                        && assignee
                            .as_deref()
                            .is_none_or(|u| t.assignee_id.as_deref() == Some(u))
                })
                .collect();
            tasks.sort_by_key(|t| t.number);
            let total = tasks.len();
            let pipeline: HashMap<&str, &str> = PipelineStage::ALL
                .iter()
                .map(|s| (s.as_str(), s.label()))
                .collect();
            let items: Vec<Value> = tasks
                .iter()
                .take(limit)
                .map(|t| ctx.task_summary(&a.project, t))
                .collect();
            Ok(json!({ "pipeline": pipeline, "total": total, "tasks": items }))
        }
        "list_cycles" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let status_f = opt_str(args, "status");
            let all_tasks: Vec<Task> = ctx
                .db()
                .tasks
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .filter(|t| t.deleted_at.is_none() && t.triage_status.is_none())
                .collect();
            let mut cycles: Vec<Cycle> = ctx
                .db()
                .cycles
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .filter(|c| status_f.is_none_or(|s| c.status == s))
                .collect();
            let rank = |s: &str| match s {
                "active" => 0,
                "upcoming" => 1,
                "completed" => 2,
                _ => 9,
            };
            cycles.sort_by(|x, y| rank(&x.status).cmp(&rank(&y.status)).then_with(|| x.start_date.cmp(&y.start_date)));
            Ok(json!(cycles
                .into_iter()
                .map(|c| {
                    let items: Vec<&Task> = all_tasks
                        .iter()
                        .filter(|t| t.cycle_id.as_deref() == Some(&c.id))
                        .collect();
                    let done: Vec<&Task> = items
                        .iter()
                        .copied()
                        .filter(|t| t.stage == PipelineStage::Done)
                        .collect();
                    let tot_pts: i64 = items.iter().map(|t| t.estimate.unwrap_or(0)).sum();
                    let done_pts: i64 = done.iter().map(|t| t.estimate.unwrap_or(0)).sum();
                    let pct = if tot_pts > 0 {
                        ((done_pts as f64 / tot_pts as f64) * 100.0).round() as i64
                    } else if !items.is_empty() {
                        ((done.len() as f64 / items.len() as f64) * 100.0).round() as i64
                    } else {
                        0
                    };
                    json!({
                        "id": c.id,
                        "name": c.name,
                        "status": c.status,
                        "start_date": c.start_date.format("%Y-%m-%d").to_string(),
                        "end_date": c.end_date.format("%Y-%m-%d").to_string(),
                        "goal": c.goal,
                        "target_points": c.target_points,
                        "total_tasks": items.len(),
                        "done_tasks": done.len(),
                        "total_points": tot_pts,
                        "done_points": done_pts,
                        "completion_pct": pct,
                    })
                })
                .collect::<Vec<_>>()))
        }
        "list_milestones" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let status_f = opt_str(args, "status");
            let all_tasks: Vec<Task> = ctx
                .db()
                .tasks
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .filter(|t| t.deleted_at.is_none() && t.triage_status.is_none())
                .collect();
            let mut items: Vec<Milestone> = ctx
                .db()
                .milestones
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .filter(|m| status_f.is_none_or(|s| m.status == s))
                .collect();
            let rank = |s: &str| match s {
                "active" => 0,
                "planned" => 1,
                "completed" => 2,
                _ => 9,
            };
            items.sort_by(|x, y| {
                rank(&x.status)
                    .cmp(&rank(&y.status))
                    .then_with(|| x.target_date.is_none().cmp(&y.target_date.is_none()))
                    .then_with(|| {
                        x.target_date
                            .unwrap_or(NaiveDate::MAX)
                            .cmp(&y.target_date.unwrap_or(NaiveDate::MAX))
                    })
                    .then_with(|| x.created_at.cmp(&y.created_at))
            });
            Ok(json!(items
                .into_iter()
                .map(|m| {
                    let linked: Vec<&Task> = all_tasks
                        .iter()
                        .filter(|t| t.milestone_id.as_deref() == Some(&m.id))
                        .collect();
                    let done = linked.iter().filter(|t| t.stage == PipelineStage::Done).count();
                    let pct = if !linked.is_empty() {
                        ((done as f64 / linked.len() as f64) * 100.0).round() as i64
                    } else {
                        0
                    };
                    json!({
                        "id": m.id,
                        "name": m.name,
                        "status": m.status,
                        "description": m.description,
                        "start_date": m.start_date.map(|d| d.format("%Y-%m-%d").to_string()),
                        "target_date": m.target_date.map(|d| d.format("%Y-%m-%d").to_string()),
                        "total_tasks": linked.len(),
                        "done_tasks": done,
                        "progress_pct": pct,
                    })
                })
                .collect::<Vec<_>>()))
        }
        "list_releases" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let version_f = opt_str(args, "version");
            let inc_cl = opt_bool(args, "include_changelog");
            let inc_unf = opt_bool(args, "include_unfinished");
            let all_tasks: Vec<Task> = ctx
                .db()
                .tasks
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .filter(|t| t.deleted_at.is_none())
                .collect();
            let summary = build_releases(&a.project, &all_tasks);
            let releases: Vec<_> = summary
                .releases
                .into_iter()
                .filter(|r| {
                    version_f
                        .is_none_or(|v| r.version.to_lowercase() == v.trim().to_lowercase())
                })
                .map(|r| {
                    json!({
                        "version": r.version,
                        "status": r.status,
                        "progress_pct": r.progress_pct,
                        "total_tasks": r.total_tasks,
                        "done_tasks": r.done_tasks,
                        "in_progress_tasks": r.in_progress_tasks,
                        "todo_tasks": r.todo_tasks,
                        "total_points": r.total_points,
                        "done_points": r.done_points,
                        "tasks": r.tasks.into_iter().map(|t| json!({
                            "key": t.key,
                            "title": t.title,
                            "stage": t.stage.as_str(),
                            "priority": t.priority,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect();
            let mut result = json!({
                "unversioned_count": summary.unversioned_count,
                "releases": releases,
            });
            if inc_cl {
                if let Some(v) = version_f {
                    let cl = build_changelog(&a.project, &all_tasks, v, inc_unf, None);
                    if let Some(m) = result.as_object_mut() {
                        m.insert("changelog".into(), json!(cl.map(|c| c.markdown)));
                    }
                }
            }
            Ok(result)
        }
        "get_task" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let t = ctx.find_task(&a.project, req_str(args, "task")?)?;
            Ok(ctx.task_detail(&a.project, &t))
        }
        "list_wiki_pages" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let pt_f: Option<PageType> = opt_str(args, "page_type")
                .and_then(|s| serde_json::from_value(json!(s)).ok());
            let st_f: Option<PageStatus> = opt_str(args, "status")
                .and_then(|s| serde_json::from_value(json!(s)).ok());
            let tag_f = opt_str(args, "tag").map(|s| s.to_lowercase());
            let mut pages = project_pages(ctx.db(), &a.project.id).map_err(|_| "DB 오류".to_string())?;
            pages.sort_by_key(|p| p.created_at);
            Ok(json!(pages
                .into_iter()
                .filter(|pg| {
                    pt_f.is_none_or(|x| pg.page_type == Some(x))
                        && st_f.is_none_or(|x| pg.status == Some(x))
                        && tag_f
                            .as_deref()
                            .is_none_or(|t| pg.tags.iter().any(|x| x.to_lowercase() == t))
                })
                .map(|pg| ctx.page_summary(&pg))
                .collect::<Vec<_>>()))
        }
        "get_wiki_page" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let pg = ctx.find_page(&a.project, req_str(args, "page")?)?;
            let mut obj = ctx.page_summary(&pg);
            if let Some(m) = obj.as_object_mut() {
                m.insert("content".into(), json!(pg.content));
                m.insert(
                    "url".into(),
                    json!(format!(
                        "{}/projects/{}/wiki/{}",
                        state.settings.app_url.trim_end_matches('/'),
                        a.project.id,
                        pg.id
                    )),
                );
            }
            Ok(obj)
        }
        "list_glossary" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let mut terms = ctx
                .db()
                .glossary_terms
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?;
            let by_id: HashMap<String, String> =
                terms.iter().map(|g| (g.id.clone(), g.term.clone())).collect();
            if let Some(q) = opt_str(args, "query").map(str::trim).filter(|s| !s.is_empty()) {
                let n = q.to_lowercase();
                terms.retain(|g| {
                    g.term.to_lowercase().contains(&n)
                        || g.definition.to_lowercase().contains(&n)
                        || g.synonyms.iter().any(|s| s.to_lowercase().contains(&n))
                });
            }
            terms.sort_by(|x, y| x.term.to_lowercase().cmp(&y.term.to_lowercase()));
            Ok(json!(terms
                .into_iter()
                .map(|g| json!({
                    "id": g.id,
                    "term": g.term,
                    "definition": g.definition,
                    "synonyms": g.synonyms,
                    "broader": g.broader_id.as_deref().and_then(|id| by_id.get(id)),
                }))
                .collect::<Vec<_>>()))
        }
        "ask_knowledge_graph" => {
            let user = ctx.me(false)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::View)?;
            let res = answer_question(ctx.db(), &a.project, req_str(args, "question")?)
                .map_err(|_| "QA 처리 오류".to_string())?;
            Ok(json!({
                "answer": res.answer,
                "expanded_terms": res.expanded_terms,
                "related_facts": res.related_facts,
                "citations": res.citations,
            }))
        }
        // ------------------------------------------------------------ Write tools
        "create_cycle" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Create)?;
            let start_date = opt_date(args, "start_date")?.ok_or("start_date 가 필요합니다")?;
            let end_date = opt_date(args, "end_date")?.ok_or("end_date 가 필요합니다")?;
            if start_date > end_date {
                return Err("start_date 는 end_date 이전이어야 합니다".into());
            }
            let status = opt_str(args, "status").unwrap_or("upcoming");
            if !matches!(status, "upcoming" | "active" | "completed") {
                return Err("status 는 upcoming / active / completed 중 하나여야 합니다".into());
            }
            let now = utcnow();
            let c = Cycle {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: a.project.id.clone(),
                name: req_str(args, "name")?.trim().to_string(),
                goal: opt_str(args, "goal").unwrap_or("").trim().to_string(),
                start_date,
                end_date,
                target_points: args.get("target_points").and_then(|v| v.as_i64()),
                status: status.into(),
                created_by: user.id,
            };
            ctx.db().cycles.create(&c).map_err(|_| "DB 오류".to_string())?;
            publish_event(
                ctx.db(),
                &state.events,
                &a.project.id,
                "cycle.updated",
                json!({ "cycle_id": c.id }),
            );
            Ok(json!({
                "id": c.id,
                "name": c.name,
                "status": c.status,
                "start_date": c.start_date.format("%Y-%m-%d").to_string(),
                "end_date": c.end_date.format("%Y-%m-%d").to_string(),
                "goal": c.goal,
            }))
        }
        "create_milestone" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Create)?;
            let start_date = opt_date(args, "start_date")?;
            let target_date = opt_date(args, "target_date")?;
            if let (Some(s), Some(t)) = (start_date, target_date) {
                if s > t {
                    return Err("start_date 는 target_date 이전이어야 합니다".into());
                }
            }
            let status = opt_str(args, "status").unwrap_or("planned");
            if !matches!(status, "planned" | "active" | "completed") {
                return Err("status 는 planned / active / completed 중 하나여야 합니다".into());
            }
            let now = utcnow();
            let m = Milestone {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: a.project.id.clone(),
                name: req_str(args, "name")?.trim().to_string(),
                description: opt_str(args, "description").unwrap_or("").trim().to_string(),
                start_date,
                target_date,
                status: status.into(),
                created_by: user.id,
            };
            ctx.db().milestones.create(&m).map_err(|_| "DB 오류".to_string())?;
            publish_event(
                ctx.db(),
                &state.events,
                &a.project.id,
                "milestone.updated",
                json!({ "milestone_id": m.id }),
            );
            Ok(json!({
                "id": m.id,
                "name": m.name,
                "status": m.status,
                "description": m.description,
                "start_date": m.start_date.map(|d| d.format("%Y-%m-%d").to_string()),
                "target_date": m.target_date.map(|d| d.format("%Y-%m-%d").to_string()),
            }))
        }
        "create_task" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Create)?;
            let title = req_str(args, "title")?.trim().to_string();
            let stage = match opt_str(args, "stage") {
                Some(s) => parse_stage(s)?,
                None => PipelineStage::Backlog,
            };
            let priority = match opt_str(args, "priority") {
                Some(p) => parse_priority(p)?,
                None => Priority::Medium,
            };
            let parent_id = match opt_str(args, "parent") {
                Some(p) => Some(ctx.find_task(&a.project, p)?.id),
                None => None,
            };
            let cycle_id = match opt_str(args, "cycle") {
                Some(c) => Some(ctx.find_cycle(&a.project, c)?.id),
                None => None,
            };
            let milestone_id = match opt_str(args, "milestone") {
                Some(m) => Some(ctx.find_milestone(&a.project, m)?.id),
                None => None,
            };
            let assignee_id = ctx.user_by_email(&a.project, opt_str(args, "assignee_email"))?;
            let start_date = opt_date(args, "start_date")?;
            let due_date = opt_date(args, "due_date")?;
            if let (Some(s), Some(d)) = (start_date, due_date) {
                if s > d {
                    return Err("start_date 는 due_date 이전이어야 합니다".into());
                }
            }
            let checklist: Vec<ChecklistItem> = opt_str_list(args, "checklist")
                .unwrap_or_default()
                .into_iter()
                .filter(|c| !c.trim().is_empty())
                .map(|c| ChecklistItem {
                    id: new_id(),
                    text: c,
                    done: false,
                })
                .collect();
            let number = ctx
                .db()
                .allocate_task_number(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .ok_or("프로젝트를 찾을 수 없습니다")?;
            let via = ctx.actor_client();
            let now = utcnow();
            let t = Task {
                id: new_id(),
                created_at: now,
                updated_at: now,
                title,
                description: opt_str(args, "description").unwrap_or("").to_string(),
                stage,
                priority,
                parent_id,
                cycle_id,
                milestone_id,
                version: clean_version(opt_str(args, "version").map(str::to_string)),
                assignee_id,
                tags: opt_str_list(args, "tags").unwrap_or_default(),
                start_date,
                due_date,
                estimate: None,
                checklist,
                triage_status: None,
                triage_snooze_until: None,
                triage_source: String::new(),
                project_id: a.project.id.clone(),
                number,
                created_by: user.id.clone(),
                watcher_ids: vec![],
                deleted_at: None,
                deleted_by: None,
                via_client: via.clone(),
            };
            ctx.db().tasks.create(&t).map_err(|_| "DB 오류".to_string())?;
            record_created(ctx.db(), &t, &user.id, via);
            publish_event(
                ctx.db(),
                &state.events,
                &a.project.id,
                "task.created",
                json!({ "task_id": t.id, "stage": t.stage.as_str() }),
            );
            Ok(ctx.task_detail(&a.project, &t))
        }
        "link_tasks" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Edit)?;
            let src = ctx.find_task(&a.project, req_str(args, "source_task")?)?;
            let dst = ctx.find_task(&a.project, req_str(args, "target_task")?)?;
            if src.id == dst.id {
                return Err("자기 자신과 연결할 수 없습니다".into());
            }
            let kind: TaskLinkKind = match opt_str(args, "kind") {
                Some(k) => serde_json::from_value(json!(k)).map_err(|_| format!("잘못된 kind: {k}"))?,
                None => TaskLinkKind::RelatesTo,
            };
            if let Some(existing) = ctx
                .db()
                .task_links
                .list_by_project(&a.project.id)
                .map_err(|_| "DB 오류".to_string())?
                .into_iter()
                .find(|l| l.source_id == src.id && l.target_id == dst.id && l.kind == kind)
            {
                return Ok(json!({
                    "id": existing.id,
                    "source": format!("{}-{}", a.project.key, src.number),
                    "target": format!("{}-{}", a.project.key, dst.number),
                    "kind": kind.as_str(),
                }));
            }
            let now = utcnow();
            let created = TaskLink {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: a.project.id,
                source_id: src.id,
                target_id: dst.id,
                kind,
                created_by: user.id,
            };
            ctx.db()
                .task_links
                .create(&created)
                .map_err(|_| "DB 오류".to_string())?;
            Ok(json!({
                "id": created.id,
                "source": format!("{}-{}", a.project.key, src.number),
                "target": format!("{}-{}", a.project.key, dst.number),
                "kind": kind.as_str(),
            }))
        }
        "update_task" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Edit)?;
            let before = ctx.find_task(&a.project, req_str(args, "task")?)?;
            let mut after = before.clone();

            if let Some(t) = opt_str(args, "title") {
                after.title = t.trim().to_string();
            }
            if let Some(d) = opt_str(args, "description") {
                after.description = d.to_string();
            }
            if let Some(s) = opt_str(args, "stage") {
                after.stage = parse_stage(s)?;
            }
            if let Some(p) = opt_str(args, "priority") {
                after.priority = parse_priority(p)?;
            }
            if opt_bool(args, "clear_version") {
                after.version = None;
            } else if let Some(v) = opt_str(args, "version") {
                after.version = clean_version(Some(v.to_string()));
            }
            if opt_bool(args, "clear_cycle") {
                after.cycle_id = None;
            } else if let Some(c) = opt_str(args, "cycle") {
                after.cycle_id = Some(ctx.find_cycle(&a.project, c)?.id);
            }
            if opt_bool(args, "clear_milestone") {
                after.milestone_id = None;
            } else if let Some(m) = opt_str(args, "milestone") {
                after.milestone_id = Some(ctx.find_milestone(&a.project, m)?.id);
            }
            if opt_bool(args, "unassign") {
                after.assignee_id = None;
            } else if let Some(em) = opt_str(args, "assignee_email").filter(|s| !s.is_empty()) {
                after.assignee_id = ctx.user_by_email(&a.project, Some(em))?;
            }
            if let Some(sd) = opt_date(args, "start_date")? {
                after.start_date = Some(sd);
            }
            if let Some(dd) = opt_date(args, "due_date")? {
                after.due_date = Some(dd);
            }
            if let (Some(s), Some(d)) = (after.start_date, after.due_date) {
                if s > d {
                    return Err("start_date 는 due_date 이전이어야 합니다".into());
                }
            }
            if let Some(tags) = opt_str_list(args, "tags") {
                after.tags = tags;
            }
            if let Some(items) = opt_str_list(args, "check_items") {
                let wanted: HashSet<String> = items
                    .into_iter()
                    .map(|c| c.trim().to_lowercase())
                    .collect();
                for item in &mut after.checklist {
                    if wanted.contains(&item.text.to_lowercase()) {
                        item.done = true;
                    }
                }
            }
            after.updated_at = utcnow();
            ctx.db().tasks.update(&after).map_err(|_| "DB 오류".to_string())?;
            record_changes(
                ctx.db(),
                &before,
                &after,
                &user.id,
                ctx.actor_client(),
            );
            publish_event(
                ctx.db(),
                &state.events,
                &a.project.id,
                "task.updated",
                json!({ "task_id": after.id, "stage": after.stage.as_str() }),
            );
            Ok(ctx.task_detail(&a.project, &after))
        }
        "add_comment" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Create)?;
            let t = ctx.find_task(&a.project, req_str(args, "task")?)?;
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            if body.trim().is_empty() {
                return Err("덧글 내용이 비어 있습니다".into());
            }
            let now = utcnow();
            let comment = Comment {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: a.project.id.clone(),
                task_id: t.id.clone(),
                author_id: user.id,
                body: body.chars().take(20000).collect(),
                reactions: HashMap::new(),
                via_client: ctx.actor_client(),
            };
            ctx.db()
                .comments
                .create(&comment)
                .map_err(|_| "DB 오류".to_string())?;
            publish_event(
                ctx.db(),
                &state.events,
                &a.project.id,
                "comment.created",
                json!({ "task_id": t.id, "comment_id": comment.id }),
            );
            Ok(ctx.task_detail(&a.project, &t))
        }
        "create_wiki_page" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Create)?;
            let parent_id = match opt_str(args, "parent") {
                Some(p) => Some(ctx.find_page(&a.project, p)?.id),
                None => None,
            };
            let page_type: Option<PageType> = opt_str(args, "page_type")
                .map(|s| serde_json::from_value(json!(s)).map_err(|_| format!("잘못된 page_type: {s}")))
                .transpose()?;
            let status: Option<PageStatus> = opt_str(args, "status")
                .map(|s| serde_json::from_value(json!(s)).map_err(|_| format!("잘못된 status: {s}")))
                .transpose()?;
            let now = utcnow();
            let pg = WikiPage {
                id: new_id(),
                created_at: now,
                updated_at: now,
                title: req_str(args, "title")?.trim().to_string(),
                content: opt_str(args, "content").unwrap_or("").to_string(),
                parent_id,
                aliases: clean_string_list(&opt_str_list(args, "aliases").unwrap_or_default()),
                tags: clean_string_list(&opt_str_list(args, "tags").unwrap_or_default()),
                page_type,
                status,
                owner_id: None,
                project_id: a.project.id,
                created_by: user.id.clone(),
                updated_by: user.id.clone(),
                deleted_at: None,
                deleted_by: None,
            };
            ctx.db()
                .wiki_pages
                .create(&pg)
                .map_err(|_| "DB 오류".to_string())?;
            let via = ctx.actor_client();
            let note = match &via {
                Some(c) => format!("MCP 작성 ({c})"),
                None => "MCP 작성".into(),
            };
            let _ = record_revision(ctx.db(), &pg, &user.id, &note, via);
            let mut obj = ctx.page_summary(&pg);
            if let Some(m) = obj.as_object_mut() {
                m.insert("content".into(), json!(pg.content));
            }
            Ok(obj)
        }
        "update_wiki_page" => {
            let user = ctx.me(true)?;
            let a = ctx.project_access(&user, req_str(args, "project")?, Permission::Edit)?;
            let before = ctx.find_page(&a.project, req_str(args, "page")?)?;
            let mut after = before.clone();

            if let Some(t) = opt_str(args, "title") {
                after.title = t.trim().to_string();
            }
            if let Some(c) = opt_str(args, "content") {
                after.content = c.to_string();
            }
            if let Some(app) = opt_str(args, "append").filter(|s| !s.is_empty()) {
                after.content = format!("{}\n\n{}", after.content.trim_end(), app)
                    .trim_start()
                    .to_string();
            }
            if let Some(pt) = opt_str(args, "page_type") {
                after.page_type = Some(
                    serde_json::from_value(json!(pt)).map_err(|_| format!("잘못된 page_type: {pt}"))?,
                );
            }
            if let Some(st) = opt_str(args, "status") {
                after.status = Some(
                    serde_json::from_value(json!(st)).map_err(|_| format!("잘못된 status: {st}"))?,
                );
            }
            if let Some(tags) = opt_str_list(args, "tags") {
                after.tags = clean_string_list(&tags);
            }
            if let Some(aliases) = opt_str_list(args, "aliases") {
                after.aliases = clean_string_list(&aliases);
            }
            after.updated_by = user.id.clone();
            after.updated_at = utcnow();
            ctx.db()
                .wiki_pages
                .update(&after)
                .map_err(|_| "DB 오류".to_string())?;
            let via = ctx.actor_client();
            let note = match &via {
                Some(c) => format!("MCP 수정 ({c})"),
                None => "MCP 수정".into(),
            };
            let _ = record_revision(ctx.db(), &after, &user.id, &note, via);
            let _ = propagate_rename(ctx.db(), &a.project, &after, &before.title);
            let mut obj = ctx.page_summary(&after);
            if let Some(m) = obj.as_object_mut() {
                m.insert("content".into(), json!(after.content));
            }
            Ok(obj)
        }
        _ => Err(format!("알 수 없는 도구: {name}")),
    }
}

fn tool_definitions() -> Value {
    let read_ann = json!({ "readOnlyHint": true, "openWorldHint": false });
    let create_ann = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    let update_ann = json!({ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false });
    let stages = json!(["backlog", "todo", "in_progress", "review", "qa", "done"]);
    let priorities = json!(["low", "medium", "high", "urgent"]);
    let page_types = json!(["guide", "spec", "decision", "meeting", "reference", "note"]);
    let page_statuses = json!(["draft", "review", "published", "deprecated"]);

    json!([
        {
            "name": "list_projects",
            "description": "내가 볼 수 있는 프로젝트 목록 (키·이름·내 권한).",
            "annotations": read_ann,
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "search",
            "description": "프로젝트의 일감(제목·설명·할 일·덧글·레이블)과 위키(제목·별칭·본문·태그) 검색. 'MW-12' 처럼 키로도 찾습니다.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "query": { "type": "string" }
                },
                "required": ["project", "query"]
            }
        },
        {
            "name": "list_tasks",
            "description": "일감 목록. stage·버전(version)·사이클(cycle 이름/id)·마일스톤(milestone 이름/id)·작업자 이메일·내 일감(mine)으로 거릅니다.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "stage": { "type": ["string", "null"], "enum": ["backlog", "todo", "in_progress", "review", "qa", "done", null] },
                    "version": { "type": ["string", "null"] },
                    "cycle": { "type": ["string", "null"] },
                    "milestone": { "type": ["string", "null"] },
                    "assignee_email": { "type": ["string", "null"] },
                    "mine": { "type": "boolean", "default": false },
                    "limit": { "type": "integer", "default": 50 }
                },
                "required": ["project"]
            }
        },
        {
            "name": "list_cycles",
            "description": "프로젝트의 사이클(스프린트) 목록과 진행률·포인트 집계 조회.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "status": { "type": ["string", "null"], "enum": ["upcoming", "active", "completed", null] }
                },
                "required": ["project"]
            }
        },
        {
            "name": "list_milestones",
            "description": "프로젝트의 마일스톤(에픽/릴리즈) 목록과 진척률 조회.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "status": { "type": ["string", "null"], "enum": ["planned", "active", "completed", null] }
                },
                "required": ["project"]
            }
        },
        {
            "name": "list_releases",
            "description": "프로젝트의 버전(task.version)별 릴리즈 진행 현황 조회. version 과 include_changelog=true 지정 시 Markdown 체인지로그도 반환.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "version": { "type": ["string", "null"] },
                    "include_changelog": { "type": "boolean", "default": false },
                    "include_unfinished": { "type": "boolean", "default": false }
                },
                "required": ["project"]
            }
        },
        {
            "name": "get_task",
            "description": "일감 상세 (설명·할 일·덧글 포함). task 는 'MW-12' 또는 번호.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "task": { "type": "string" }
                },
                "required": ["project", "task"]
            }
        },
        {
            "name": "list_wiki_pages",
            "description": "위키 페이지 목록 (본문 제외). 타입·상태·태그로 거릅니다.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "page_type": { "type": ["string", "null"] },
                    "status": { "type": ["string", "null"] },
                    "tag": { "type": ["string", "null"] }
                },
                "required": ["project"]
            }
        },
        {
            "name": "get_wiki_page",
            "description": "위키 페이지 본문(Markdown)과 속성. page 는 제목·별칭·id.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "page": { "type": "string" }
                },
                "required": ["project", "page"]
            }
        },
        {
            "name": "list_glossary",
            "description": "프로젝트 용어집(표제어·정의·동의어·상위 용어) 조회.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "query": { "type": ["string", "null"] }
                },
                "required": ["project"]
            }
        },
        {
            "name": "ask_knowledge_graph",
            "description": "프로젝트 용어집·지식 그래프·위키·일감을 기반으로 질문에 답하고 근거를 반환.",
            "annotations": read_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "question": { "type": "string" }
                },
                "required": ["project", "question"]
            }
        },
        {
            "name": "create_cycle",
            "description": "새 사이클(스프린트) 만들기. status 는 upcoming / active / completed.",
            "annotations": create_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "name": { "type": "string" },
                    "start_date": { "type": "string", "format": "date" },
                    "end_date": { "type": "string", "format": "date" },
                    "goal": { "type": "string", "default": "" },
                    "target_points": { "type": ["integer", "null"] },
                    "status": { "type": "string", "enum": ["upcoming", "active", "completed"], "default": "upcoming" }
                },
                "required": ["project", "name", "start_date", "end_date"]
            }
        },
        {
            "name": "create_milestone",
            "description": "새 마일스톤(릴리즈/에픽) 만들기. status 는 planned / active / completed.",
            "annotations": create_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "name": { "type": "string" },
                    "description": { "type": "string", "default": "" },
                    "start_date": { "type": ["string", "null"], "format": "date" },
                    "target_date": { "type": ["string", "null"], "format": "date" },
                    "status": { "type": "string", "enum": ["planned", "active", "completed"], "default": "planned" }
                },
                "required": ["project", "name"]
            }
        },
        {
            "name": "create_task",
            "description": "일감 만들기. version('v0.6.0')·cycle(이름/id)·milestone(이름/id)·parent('MW-1')·checklist 지원.",
            "annotations": create_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "title": { "type": "string" },
                    "description": { "type": "string", "default": "" },
                    "stage": { "type": "string", "enum": stages, "default": "backlog" },
                    "priority": { "type": "string", "enum": priorities, "default": "medium" },
                    "version": { "type": ["string", "null"] },
                    "cycle": { "type": ["string", "null"] },
                    "milestone": { "type": ["string", "null"] },
                    "parent": { "type": ["string", "null"] },
                    "assignee_email": { "type": ["string", "null"] },
                    "start_date": { "type": ["string", "null"], "format": "date" },
                    "due_date": { "type": ["string", "null"], "format": "date" },
                    "tags": { "type": ["array", "null"], "items": { "type": "string" } },
                    "checklist": { "type": ["array", "null"], "items": { "type": "string" } }
                },
                "required": ["project", "title"]
            }
        },
        {
            "name": "link_tasks",
            "description": "두 일감 사이에 관계(blocks / relates_to / duplicates)를 연결.",
            "annotations": create_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "source_task": { "type": "string" },
                    "target_task": { "type": "string" },
                    "kind": { "type": "string", "enum": ["blocks", "relates_to", "duplicates"], "default": "relates_to" }
                },
                "required": ["project", "source_task", "target_task"]
            }
        },
        {
            "name": "update_task",
            "description": "일감 수정 (보낸 값만 바뀜). stage·version·cycle·milestone(이름/id, 해제는 clear_*=true)·작업자(unassign=true)·check_items 지원.",
            "annotations": update_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "task": { "type": "string" },
                    "title": { "type": ["string", "null"] },
                    "description": { "type": ["string", "null"] },
                    "stage": { "type": ["string", "null"] },
                    "priority": { "type": ["string", "null"] },
                    "version": { "type": ["string", "null"] },
                    "clear_version": { "type": "boolean", "default": false },
                    "cycle": { "type": ["string", "null"] },
                    "clear_cycle": { "type": "boolean", "default": false },
                    "milestone": { "type": ["string", "null"] },
                    "clear_milestone": { "type": "boolean", "default": false },
                    "assignee_email": { "type": ["string", "null"] },
                    "unassign": { "type": "boolean", "default": false },
                    "start_date": { "type": ["string", "null"], "format": "date" },
                    "due_date": { "type": ["string", "null"], "format": "date" },
                    "tags": { "type": ["array", "null"], "items": { "type": "string" } },
                    "check_items": { "type": ["array", "null"], "items": { "type": "string" } }
                },
                "required": ["project", "task"]
            }
        },
        {
            "name": "add_comment",
            "description": "일감에 덧글 남기기 (Markdown).",
            "annotations": create_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "task": { "type": "string" },
                    "body": { "type": "string" }
                },
                "required": ["project", "task", "body"]
            }
        },
        {
            "name": "create_wiki_page",
            "description": "위키 페이지 만들기. content 는 Markdown([[다른 페이지]], MW-12 링크 가능), parent 는 상위 페이지 제목·id.",
            "annotations": create_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string", "default": "" },
                    "parent": { "type": ["string", "null"] },
                    "page_type": { "type": ["string", "null"], "enum": page_types },
                    "status": { "type": ["string", "null"], "enum": page_statuses },
                    "tags": { "type": ["array", "null"], "items": { "type": "string" } },
                    "aliases": { "type": ["array", "null"], "items": { "type": "string" } }
                },
                "required": ["project", "title"]
            }
        },
        {
            "name": "update_wiki_page",
            "description": "위키 페이지 수정 (보낸 값만). content 는 본문 전체 교체, append 는 본문 끝에 덧붙이기. 제목을 바꾸면 다른 문서의 [[링크]]도 갱신.",
            "annotations": update_ann,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "page": { "type": "string" },
                    "title": { "type": ["string", "null"] },
                    "content": { "type": ["string", "null"] },
                    "append": { "type": ["string", "null"] },
                    "page_type": { "type": ["string", "null"] },
                    "status": { "type": ["string", "null"] },
                    "tags": { "type": ["array", "null"], "items": { "type": "string" } },
                    "aliases": { "type": ["array", "null"], "items": { "type": "string" } }
                },
                "required": ["project", "page"]
            }
        }
    ])
}
