use std::collections::{HashMap, HashSet};

use axum::extract::{Form, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::models::{scope_labels, GrantRead, OAUTH_SCOPES, SCOPE_READ};
use crate::routes::deps::AuthUser;
use crate::services::oauth::{
    self, OAuthError, PendingAuthorization, AUTH_REQUEST_TTL_SEC,
};
use crate::AppState;

static ICON_PNG: &[u8] = include_bytes!("../../assets/icon.png");

pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(as_metadata))
        .route("/.well-known/oauth-protected-resource", get(prm_metadata))
        .route("/.well-known/oauth-protected-resource/mcp", get(prm_metadata))
        .route("/oauth/register", post(register))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/token", post(token))
        .route("/oauth/revoke", post(revoke))
        .route("/icon.png", get(icon))
}

pub fn api_router() -> Router<AppState> {
    Router::new()
        .route("/oauth/requests/{request_id}", get(get_request))
        .route("/oauth/requests/{request_id}/decision", post(decide))
        .route("/oauth/grants", get(list_grants))
        .route("/oauth/grants/{grant_id}", delete(delete_grant))
}

fn no_store_json(status: StatusCode, body: Value, extra_auth: bool) -> Response {
    let mut res = (status, Json(body)).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    if extra_auth {
        h.insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static(r#"Basic realm="oauth""#),
        );
    }
    res
}

fn oauth_err_resp(e: OAuthError) -> Response {
    let st = StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_REQUEST);
    no_store_json(
        st,
        json!({ "error": e.error, "error_description": e.description }),
        e.status == 401,
    )
}

fn error_page(msg: &str) -> Response {
    let esc = msg
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    (
        StatusCode::BAD_REQUEST,
        Html(format!(
            "<!doctype html><meta charset=utf-8><title>연결 오류</title>\
             <body style='font-family:system-ui;max-width:520px;margin:80px auto;color:#0e1320'>\
             <h2>앱 연결을 진행할 수 없습니다</h2><p>{esc}</p></body>"
        )),
    )
        .into_response()
}

async fn as_metadata(State(state): State<AppState>) -> Json<Value> {
    Json(oauth::authorization_server_metadata(&state.settings))
}

async fn prm_metadata(State(state): State<AppState>) -> Json<Value> {
    Json(oauth::protected_resource_metadata(&state.settings))
}

async fn icon() -> Response {
    let mut res = ICON_PNG.into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    res
}

async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: axum::body::Bytes,
) -> Response {
    let client_ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown");

    let allowed = state
        .db
        .engine
        .check_dcr_rate_limit(client_ip, state.settings.oauth_dcr_rate_limit_per_min)
        .unwrap_or(true);
    if !allowed {
        return oauth_err_resp(OAuthError::new("too_many_requests", "잠시 후 다시 시도하세요", 429));
    }
    let body: Value = match serde_json::from_slice::<Value>(&body_bytes) {
        Ok(v) if v.is_object() => v,
        _ => {
            return oauth_err_resp(OAuthError::bad(
                "invalid_client_metadata",
                "JSON 본문이 필요합니다",
            ));
        }
    };
    match oauth::register_client(&state.db, &body, state.settings.oauth_dcr_max_clients) {
        Ok(val) => no_store_json(StatusCode::CREATED, val, false),
        Err(e) => oauth_err_resp(e),
    }
}

async fn authorize(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let client_id = q.get("client_id").map(String::as_str).unwrap_or("");
    let client = match oauth::get_client(&state.settings, &state.db, client_id).await {
        Ok(c) => c,
        Err(e) => return error_page(&e.description),
    };
    let redirect_uri = match q.get("redirect_uri").filter(|s| !s.is_empty()) {
        Some(u) => u.clone(),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        None => return error_page("등록되지 않은 redirect_uri 입니다."),
    };
    if !oauth::redirect_uri_matches(&client.redirect_uris, &redirect_uri) {
        return error_page("등록되지 않은 redirect_uri 입니다.");
    }
    let state_param = q.get("state").cloned();
    let fail = |err: &str, desc: &str| {
        let loc = oauth::redirect_with(
            &state.settings,
            &redirect_uri,
            &[
                ("error", Some(err)),
                ("error_description", Some(desc)),
                ("state", state_param.as_deref()),
            ],
        );
        Redirect::temporary(&loc).into_response()
    };

    if q.get("response_type").map(String::as_str) != Some("code") {
        return fail("unsupported_response_type", "response_type=code 만 지원합니다");
    }
    let code_challenge = q.get("code_challenge").map(String::as_str).unwrap_or("");
    if code_challenge.is_empty() || q.get("code_challenge_method").map(String::as_str) != Some("S256") {
        return fail("invalid_request", "PKCE(code_challenge_method=S256)가 필요합니다");
    }
    let scopes = match oauth::parse_scopes(q.get("scope").map(String::as_str)) {
        Ok(s) => s,
        Err(e) => return fail(&e.error, &e.description),
    };
    let resource = match oauth::normalize_resource(&state.settings, q.get("resource").map(String::as_str)) {
        Ok(r) => r,
        Err(e) => return fail(&e.error, &e.description),
    };

    let pending = PendingAuthorization {
        id: oauth::token_urlsafe(24),
        client,
        redirect_uri: redirect_uri.clone(),
        state: state_param.clone(),
        code_challenge: code_challenge.to_string(),
        scopes,
        resource,
    };
    let payload = serde_json::to_string(&pending).unwrap();
    if state
        .db
        .engine
        .put_oauth_pending(&pending.id, &payload, AUTH_REQUEST_TTL_SEC)
        .is_err()
    {
        return fail("server_error", "DB 오류");
    }

    let consent_url = format!(
        "{}/oauth/consent?request={}",
        state.settings.app_url.trim_end_matches('/'),
        pending.id
    );
    Redirect::temporary(&consent_url).into_response()
}

fn client_auth(headers: &HeaderMap, form: &HashMap<String, String>) -> Result<(String, Option<String>), OAuthError> {
    if let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(b64) = auth.strip_prefix("Basic ").or_else(|| auth.strip_prefix("basic ")) {
            let decoded = STANDARD
                .decode(b64.trim())
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .ok_or_else(|| OAuthError::new("invalid_client", "Basic 인증 형식 오류", 401))?;
            let (cid, sec) = decoded
                .split_once(':')
                .ok_or_else(|| OAuthError::new("invalid_client", "Basic 인증 형식 오류", 401))?;
            let cid_dec = urlencoding::decode(cid)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| cid.to_string());
            let sec_dec = urlencoding::decode(sec)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| sec.to_string());
            return Ok((cid_dec, Some(sec_dec)));
        }
    }
    let cid = form.get("client_id").cloned().unwrap_or_default();
    let sec = form.get("client_secret").cloned();
    Ok((cid, sec))
}

async fn token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let res: Result<Value, OAuthError> = async {
        let (cid, secret) = client_auth(&headers, &form)?;
        let client = oauth::get_client(&state.settings, &state.db, &cid).await?;
        oauth::authenticate_client(&client, secret.as_deref())?;
        let gt = form.get("grant_type").map(String::as_str).unwrap_or("");
        match gt {
            "authorization_code" => oauth::exchange_code(&state.settings, &state.db, &form, &client),
            "refresh_token" => oauth::refresh_oauth_token(&state.settings, &state.db, &form, &client),
            _ => Err(OAuthError::bad(
                "unsupported_grant_type",
                format!("지원하지 않는 grant_type: {gt}"),
            )),
        }
    }
    .await;
    match res {
        Ok(val) => no_store_json(StatusCode::OK, val, false),
        Err(e) => oauth_err_resp(e),
    }
}

async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let auth_res: Result<oauth::ClientInfo, OAuthError> = async {
        let (cid, secret) = client_auth(&headers, &form)?;
        let client = oauth::get_client(&state.settings, &state.db, &cid).await?;
        oauth::authenticate_client(&client, secret.as_deref())?;
        Ok(client)
    }
    .await;
    match auth_res {
        Ok(client) => {
            let tok = form.get("token").map(String::as_str).unwrap_or("");
            oauth::revoke_token(&state.db, tok, &client);
            StatusCode::OK.into_response()
        }
        Err(e) => oauth_err_resp(e),
    }
}

// ---------------------------------------------------------------- Consent & Grants API (/api/oauth/*)

#[derive(Debug, Serialize)]
struct ConsentRequest {
    client_id: String,
    client_name: String,
    registration: String,
    redirect_host: String,
    requested_scopes: Vec<String>,
    scope_labels: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct Decision {
    approve: bool,
    #[serde(default)]
    scopes: Vec<String>,
}

async fn get_request(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    AuthUser(_): AuthUser,
) -> ApiResult<Json<ConsentRequest>> {
    let raw = state
        .db
        .engine
        .get_oauth_pending(&request_id)?
        .ok_or_else(|| {
            ApiError::not_found("연결 요청이 없거나 만료되었습니다. 앱에서 다시 시도하세요.")
        })?;
    let p: PendingAuthorization = serde_json::from_str(&raw)?;
    let redirect_host = reqwest::Url::parse(&p.redirect_uri)
        .ok()
        .map(|u| {
            if let Some(h) = u.host_str() {
                match u.port() {
                    Some(port) => format!("{h}:{port}"),
                    None => h.to_string(),
                }
            } else {
                format!("{}:", u.scheme())
            }
        })
        .unwrap_or_default();

    Ok(Json(ConsentRequest {
        client_id: p.client.client_id,
        client_name: p.client.client_name,
        registration: p.client.via,
        redirect_host,
        requested_scopes: p.scopes,
        scope_labels: scope_labels(),
    }))
}

async fn decide(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<Decision>,
) -> ApiResult<Json<Value>> {
    let raw = state
        .db
        .engine
        .pop_oauth_pending(&request_id)?
        .ok_or_else(|| {
            ApiError::not_found("연결 요청이 없거나 만료되었습니다. 앱에서 다시 시도하세요.")
        })?;
    let p: PendingAuthorization = serde_json::from_str(&raw)?;

    if !body.approve {
        let loc = oauth::redirect_with(
            &state.settings,
            &p.redirect_uri,
            &[
                ("error", Some("access_denied")),
                ("error_description", Some("사용자가 거부했습니다")),
                ("state", p.state.as_deref()),
            ],
        );
        return Ok(Json(json!({ "redirect_to": loc })));
    }

    let requested_set: HashSet<&str> = p.scopes.iter().map(String::as_str).collect();
    let mut scopes: Vec<String> = OAUTH_SCOPES
        .iter()
        .copied()
        .filter(|s| body.scopes.iter().any(|x| x == s) && requested_set.contains(s))
        .map(str::to_string)
        .collect();
    if scopes.is_empty() {
        scopes = p.scopes.clone();
    }
    if requested_set.contains(SCOPE_READ) && !scopes.iter().any(|s| s == SCOPE_READ) {
        scopes.insert(0, SCOPE_READ.into());
    }

    let loc = oauth::approve(&state.settings, &state.db, &p, &user.id, scopes)
        .map_err(|e| ApiError::bad_request(e.description))?;
    Ok(Json(json!({ "redirect_to": loc })))
}

async fn list_grants(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<GrantRead>>> {
    let mut grants = state.db.oauth_grants.list_where(|g| g.user_id == user.id)?;
    grants.sort_by_key(|g| g.created_at);
    Ok(Json(
        grants
            .into_iter()
            .map(|g| GrantRead {
                id: g.id,
                client_id: g.client_id,
                client_name: g.client_name,
                scopes: g.scopes,
                created_at: g.created_at,
                last_used_at: g.last_used_at,
            })
            .collect(),
    ))
}

async fn delete_grant(
    State(state): State<AppState>,
    Path(grant_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let g = state
        .db
        .oauth_grants
        .get(&grant_id)?
        .ok_or_else(|| ApiError::not_found("연결을 찾을 수 없습니다"))?;
    if g.user_id != user.id {
        return Err(ApiError::not_found("연결을 찾을 수 없습니다"));
    }
    oauth::revoke_grant(&state.db, &g.id);
    Ok(StatusCode::NO_CONTENT)
}
