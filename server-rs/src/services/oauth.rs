use std::collections::{HashMap, HashSet};
use std::net::ToSocketAddrs;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::Settings;
use crate::db::Database;
use crate::models::{
    new_id, utcnow, OAuthClient, OAuthGrant, RefreshToken, OAUTH_SCOPES, SCOPE_READ, SCOPE_WRITE,
};
use crate::services::webhooks::is_public_ip;

type HmacSha256 = Hmac<Sha256>;

pub const AUTH_REQUEST_TTL_SEC: f64 = 600.0;
pub const CODE_TTL_SEC: f64 = 300.0;
const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1", "[::1]"];
const FORBIDDEN_SCHEMES: &[&str] = &["javascript", "data", "file", "vbscript", "about", "blob"];

#[derive(Debug, Clone)]
pub struct OAuthError {
    pub error: String,
    pub description: String,
    pub status: u16,
}

impl OAuthError {
    pub fn new(error: impl Into<String>, description: impl Into<String>, status: u16) -> Self {
        Self {
            error: error.into(),
            description: description.into(),
            status,
        }
    }

    pub fn bad(error: impl Into<String>, description: impl Into<String>) -> Self {
        Self::new(error, description, 400)
    }
}

pub fn token_urlsafe(n_bytes: usize) -> String {
    let mut bytes = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256_hex(val: &str) -> String {
    let mut h = Sha256::new();
    h.update(val.as_bytes());
    hex::encode(h.finalize())
}

pub fn const_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn mcp_token_key(settings: &Settings) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(settings.jwt_secret.as_bytes()).expect("hmac");
    mac.update(b"mightywork/mcp-access-token/v1");
    mac.finalize().into_bytes().to_vec()
}

pub fn authorization_server_metadata(settings: &Settings) -> Value {
    let base = settings.base_url();
    json!({
        "issuer": settings.issuer(),
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "registration_endpoint": format!("{base}/oauth/register"),
        "revocation_endpoint": format!("{base}/oauth/revoke"),
        "scopes_supported": OAUTH_SCOPES,
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "client_id_metadata_document_supported": true,
        "authorization_response_iss_parameter_supported": true,
    })
}

pub fn protected_resource_metadata(settings: &Settings) -> Value {
    json!({
        "resource": settings.resource_url(),
        "authorization_servers": [settings.issuer()],
        "scopes_supported": OAUTH_SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": settings.app_name,
    })
}

// ---------------------------------------------------------------- CIMD Metadata Document

const CIMD_MAX_BYTES: usize = 64 * 1024;
const CIMD_CACHE_TTL: Duration = Duration::from_secs(600);
const CIMD_MAX_CACHE: usize = 256;

fn cimd_cache() -> &'static RwLock<HashMap<String, (Instant, Value)>> {
    static CACHE: OnceLock<RwLock<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn is_cimd_client_id(client_id: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(client_id) else {
        return false;
    };
    url.scheme() == "https" && url.host_str().is_some() && !matches!(url.path(), "" | "/")
}

pub async fn fetch_cimd_metadata(client_id: &str, allow_private: bool) -> Result<Value, String> {
    {
        let guard = cimd_cache().read().unwrap();
        if let Some((exp, doc)) = guard.get(client_id) {
            if *exp > Instant::now() {
                return Ok(doc.clone());
            }
        }
    }
    if !is_cimd_client_id(client_id) {
        return Err("client_id 는 경로가 있는 https URL 이어야 합니다".into());
    }
    let parsed = reqwest::Url::parse(client_id).map_err(|_| "잘못된 client_id URL".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "호스트가 비어 있습니다".to_string())?
        .to_string();
    let port = parsed.port().unwrap_or(443);

    // Resolve and check all IPs before connecting
    let resolved_addrs: Vec<std::net::SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| format!("호스트를 찾을 수 없습니다: {host}"))?
        .collect();
    if resolved_addrs.is_empty() {
        return Err(format!("호스트를 찾을 수 없습니다: {host}"));
    }
    if !allow_private {
        for addr in &resolved_addrs {
            if !is_public_ip(addr.ip()) {
                return Err(format!("공개 주소가 아닌 호스트는 허용하지 않습니다: {host}"));
            }
        }
    }

    // Pin resolved IP to prevent DNS rebinding TOCTOU while keeping TLS SNI/cert verification for `host`
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(Policy::none())
        .resolve(&host, resolved_addrs[0])
        .build()
        .map_err(|e| format!("HTTP 클라이언트 오류: {e}"))?;

    let resp = client
        .get(client_id)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "클라이언트 메타데이터를 가져오지 못했습니다".to_string())?;
    if resp.status().as_u16() != 200 {
        return Err(format!(
            "클라이언트 메타데이터를 가져오지 못했습니다 (HTTP {})",
            resp.status().as_u16()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| "클라이언트 메타데이터를 가져오지 못했습니다".to_string())?;
    if bytes.len() > CIMD_MAX_BYTES {
        return Err("클라이언트 메타데이터 문서가 너무 큽니다".into());
    }
    let doc: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "클라이언트 메타데이터가 JSON 이 아닙니다".to_string())?;
    let obj = doc
        .as_object()
        .ok_or_else(|| "메타데이터 형식이 잘못되었습니다".to_string())?;
    if obj.get("client_id").and_then(|v| v.as_str()) != Some(client_id) {
        return Err("메타데이터의 client_id 가 문서 URL 과 다릅니다".into());
    }
    let uris_ok = obj
        .get("redirect_uris")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty() && a.iter().all(|x| x.is_string()));
    if !uris_ok {
        return Err("메타데이터에 redirect_uris 가 없습니다".into());
    }
    if obj.get("client_name").is_some_and(|v| !v.is_string()) {
        return Err("client_name 형식이 잘못되었습니다".into());
    }
    if obj
        .get("token_endpoint_auth_method")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        != "none"
    {
        return Err("CIMD 클라이언트는 공개 클라이언트(token_endpoint_auth_method=none)만 지원합니다".into());
    }

    {
        let mut guard = cimd_cache().write().unwrap();
        let now = Instant::now();
        guard.retain(|_, (exp, _)| *exp > now);
        while guard.len() >= CIMD_MAX_CACHE {
            if let Some(k) = guard.keys().next().cloned() {
                guard.remove(&k);
            } else {
                break;
            }
        }
        guard.insert(client_id.to_string(), (now + CIMD_CACHE_TTL, doc.clone()));
    }
    Ok(doc)
}

// ---------------------------------------------------------------- Clients & Redirect URIs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub client_id: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub auth_method: String,
    pub secret_hash: Option<String>,
    pub via: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuthorization {
    pub id: String,
    pub client: ClientInfo,
    pub redirect_uri: String,
    pub state: Option<String>,
    pub code_challenge: String,
    pub scopes: Vec<String>,
    pub resource: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationCode {
    pub user_id: String,
    pub grant_id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub scopes: Vec<String>,
    pub resource: String,
}

pub fn validate_redirect_uri(uri: &str) -> Result<(), OAuthError> {
    let parsed = reqwest::Url::parse(uri)
        .map_err(|_| OAuthError::bad("invalid_redirect_uri", format!("잘못된 redirect_uri: {uri}")))?;
    if parsed.fragment().is_some() {
        return Err(OAuthError::bad("invalid_redirect_uri", format!("잘못된 redirect_uri: {uri}")));
    }
    let scheme = parsed.scheme().to_lowercase();
    if FORBIDDEN_SCHEMES.contains(&scheme.as_str()) {
        return Err(OAuthError::bad("invalid_redirect_uri", format!("허용하지 않는 스킴: {scheme}")));
    }
    if scheme == "http" {
        let host = parsed.host_str().unwrap_or("");
        if !LOOPBACK_HOSTS.contains(&host) {
            return Err(OAuthError::bad(
                "invalid_redirect_uri",
                "http redirect_uri 는 루프백(localhost) 주소만 허용합니다",
            ));
        }
    }
    if scheme == "https" && parsed.host_str().is_none() {
        return Err(OAuthError::bad("invalid_redirect_uri", format!("잘못된 redirect_uri: {uri}")));
    }
    Ok(())
}

pub fn redirect_uri_matches(registered: &[String], requested: &str) -> bool {
    if registered.iter().any(|r| r == requested) {
        return true;
    }
    let Ok(req) = reqwest::Url::parse(requested) else {
        return false;
    };
    let host = req.host_str().unwrap_or("");
    if req.scheme() != "http" || !LOOPBACK_HOSTS.contains(&host) {
        return false;
    }
    for r in registered {
        if let Ok(reg) = reqwest::Url::parse(r) {
            if reg.scheme() == "http"
                && reg.host_str() == req.host_str()
                && reg.path() == req.path()
                && reg.query() == req.query()
            {
                return true;
            }
        }
    }
    false
}

pub fn register_client(db: &Database, metadata: &Value, max_clients: usize) -> Result<Value, OAuthError> {
    let existing = db
        .oauth_clients
        .list()
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?;
    if max_clients > 0 && existing.len() >= max_clients {
        return Err(OAuthError::new(
            "too_many_requests",
            "등록 가능한 동적 클라이언트 수 한도에 도달했습니다",
            429,
        ));
    }
    let obj = metadata
        .as_object()
        .ok_or_else(|| OAuthError::bad("invalid_client_metadata", "JSON 본문이 필요합니다"))?;
    let uris: Vec<String> = obj
        .get("redirect_uris")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty() && a.iter().all(|x| x.is_string()))
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .ok_or_else(|| OAuthError::bad("invalid_redirect_uri", "redirect_uris 가 필요합니다"))?;
    for uri in &uris {
        validate_redirect_uri(uri)?;
    }
    let method = obj
        .get("token_endpoint_auth_method")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    if !matches!(method, "none" | "client_secret_post" | "client_secret_basic") {
        return Err(OAuthError::bad(
            "invalid_client_metadata",
            format!("지원하지 않는 token_endpoint_auth_method: {method}"),
        ));
    }
    if let Some(gt) = obj.get("grant_types").and_then(|v| v.as_array()) {
        for g in gt {
            if !matches!(g.as_str(), Some("authorization_code" | "refresh_token")) {
                return Err(OAuthError::bad(
                    "invalid_client_metadata",
                    "authorization_code / refresh_token 만 지원합니다",
                ));
            }
        }
    }
    let app_type = obj
        .get("application_type")
        .and_then(|v| v.as_str())
        .unwrap_or("native");
    if !matches!(app_type, "web" | "native") {
        return Err(OAuthError::bad(
            "invalid_client_metadata",
            "application_type 은 web 또는 native",
        ));
    }
    let name: String = obj
        .get("client_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("이름 없는 앱")
        .chars()
        .take(100)
        .collect();
    let secret = if method != "none" {
        Some(token_urlsafe(32))
    } else {
        None
    };

    let now = utcnow();
    let client = OAuthClient {
        id: new_id(),
        created_at: now,
        updated_at: now,
        client_id: format!("mwc_{}", token_urlsafe(18)),
        client_secret_hash: secret.as_deref().map(sha256_hex),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: method.into(),
        application_type: app_type.into(),
    };
    db.oauth_clients
        .create(&client)
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?;

    let mut out = json!({
        "client_id": client.client_id,
        "client_id_issued_at": client.created_at.timestamp(),
        "client_name": client.client_name,
        "redirect_uris": client.redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
        "application_type": app_type,
    });
    if let Some(sec) = secret {
        if let Some(m) = out.as_object_mut() {
            m.insert("client_secret".into(), json!(sec));
            m.insert("client_secret_expires_at".into(), json!(0));
        }
    }
    Ok(out)
}

pub async fn get_client(settings: &Settings, db: &Database, client_id: &str) -> Result<ClientInfo, OAuthError> {
    if is_cimd_client_id(client_id) {
        let doc = fetch_cimd_metadata(client_id, settings.oauth_allow_private_cimd)
            .await
            .map_err(|e| OAuthError::new("invalid_client", e, 401))?;
        let uris: Vec<String> = doc["redirect_uris"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        for u in &uris {
            validate_redirect_uri(u)?;
        }
        let host = reqwest::Url::parse(client_id)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| client_id.to_string());
        let name: String = doc
            .get("client_name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&host)
            .chars()
            .take(100)
            .collect();
        return Ok(ClientInfo {
            client_id: client_id.to_string(),
            client_name: name,
            redirect_uris: uris,
            auth_method: "none".into(),
            secret_hash: None,
            via: "cimd".into(),
        });
    }

    let found = db
        .oauth_clients
        .list()
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?
        .into_iter()
        .find(|c| c.client_id == client_id)
        .ok_or_else(|| OAuthError::new("invalid_client", "등록되지 않은 클라이언트입니다", 401))?;
    Ok(ClientInfo {
        client_id: found.client_id,
        client_name: found.client_name,
        redirect_uris: found.redirect_uris,
        auth_method: found.token_endpoint_auth_method,
        secret_hash: found.client_secret_hash,
        via: "dcr".into(),
    })
}

pub fn authenticate_client(client: &ClientInfo, presented_secret: Option<&str>) -> Result<(), OAuthError> {
    if client.auth_method == "none" {
        return Ok(());
    }
    let Some(secret) = presented_secret else {
        return Err(OAuthError::new("invalid_client", "클라이언트 인증 실패", 401));
    };
    let Some(expected) = client.secret_hash.as_deref() else {
        return Err(OAuthError::new("invalid_client", "클라이언트 인증 실패", 401));
    };
    if !const_eq(&sha256_hex(secret), expected) {
        return Err(OAuthError::new("invalid_client", "클라이언트 인증 실패", 401));
    }
    Ok(())
}

// ---------------------------------------------------------------- Scopes, Resource, Redirects

pub fn normalize_resource(settings: &Settings, resource: Option<&str>) -> Result<String, OAuthError> {
    let expected = settings.resource_url();
    match resource {
        None => Ok(expected),
        Some(r) if r.trim_end_matches('/') == expected => Ok(expected),
        Some(_) => Err(OAuthError::bad(
            "invalid_target",
            format!("이 인가 서버는 {expected} 용 토큰만 발급합니다"),
        )),
    }
}

pub fn parse_scopes(scope: Option<&str>) -> Result<Vec<String>, OAuthError> {
    let Some(s) = scope.filter(|x| !x.trim().is_empty()) else {
        return Ok(vec![SCOPE_READ.into(), SCOPE_WRITE.into()]);
    };
    let requested: Vec<&str> = s.split_whitespace().collect();
    let unknown: Vec<&str> = requested
        .iter()
        .copied()
        .filter(|x| !OAUTH_SCOPES.contains(x))
        .collect();
    if !unknown.is_empty() {
        return Err(OAuthError::bad(
            "invalid_scope",
            format!("알 수 없는 scope: {}", unknown.join(" ")),
        ));
    }
    Ok(OAUTH_SCOPES
        .iter()
        .copied()
        .filter(|x| requested.contains(x))
        .map(str::to_string)
        .collect())
}

pub fn redirect_with(settings: &Settings, redirect_uri: &str, params: &[(&str, Option<&str>)]) -> String {
    let mut pairs: Vec<String> = Vec::new();
    for (k, v) in params {
        if let Some(val) = v {
            pairs.push(format!("{}={}", urlencoding::encode(k), urlencoding::encode(val)));
        }
    }
    let iss = settings.issuer();
    pairs.push(format!("iss={}", urlencoding::encode(&iss)));
    let sep = if redirect_uri.contains('?') { "&" } else { "?" };
    format!("{redirect_uri}{sep}{}", pairs.join("&"))
}

// ---------------------------------------------------------------- Approve & Tokens

pub fn approve(
    settings: &Settings,
    db: &Database,
    pending: &PendingAuthorization,
    user_id: &str,
    scopes: Vec<String>,
) -> Result<String, OAuthError> {
    let existing = db
        .oauth_grants
        .list()
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?
        .into_iter()
        .find(|g| g.user_id == user_id && g.client_id == pending.client.client_id);

    let grant = match existing {
        None => {
            let now = utcnow();
            let g = OAuthGrant {
                id: new_id(),
                created_at: now,
                updated_at: now,
                user_id: user_id.to_string(),
                client_id: pending.client.client_id.clone(),
                client_name: pending.client.client_name.clone(),
                scopes: scopes.clone(),
                last_used_at: None,
            };
            db.oauth_grants
                .create(&g)
                .map_err(|_| OAuthError::new("server_error", "DB error", 500))?
        }
        Some(mut g) => {
            g.scopes = scopes.clone();
            g.client_name = pending.client.client_name.clone();
            g.updated_at = utcnow();
            db.oauth_grants
                .update(&g)
                .map_err(|_| OAuthError::new("server_error", "DB error", 500))?;
            let new_set: HashSet<&str> = scopes.iter().map(String::as_str).collect();
            for rt in db
                .refresh_tokens
                .list()
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t.grant_id == g.id)
            {
                if !rt.scopes.iter().all(|s| new_set.contains(s.as_str())) {
                    let _ = db.refresh_tokens.delete(&rt.id);
                }
            }
            g
        }
    };

    let code = token_urlsafe(32);
    let data = AuthorizationCode {
        user_id: user_id.to_string(),
        grant_id: grant.id,
        client_id: pending.client.client_id.clone(),
        redirect_uri: pending.redirect_uri.clone(),
        code_challenge: pending.code_challenge.clone(),
        scopes,
        resource: pending.resource.clone(),
    };
    let payload = serde_json::to_string(&data).unwrap();
    db.engine
        .put_oauth_code(&sha256_hex(&code), &payload, CODE_TTL_SEC)
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?;

    Ok(redirect_with(
        settings,
        &pending.redirect_uri,
        &[("code", Some(&code)), ("state", pending.state.as_deref())],
    ))
}

fn pkce_ok(verifier: &str, challenge: &str) -> bool {
    if !(43..=128).contains(&verifier.len()) {
        return false;
    }
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    let digest = URL_SAFE_NO_PAD.encode(h.finalize());
    const_eq(&digest, challenge)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTokenClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub client_id: String,
    pub scope: String,
    pub grant: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
}

fn issue_tokens(
    settings: &Settings,
    db: &Database,
    user_id: &str,
    grant_id: &str,
    client_id: &str,
    scopes: &[String],
    resource: &str,
) -> Result<Value, OAuthError> {
    let now = Utc::now();
    let claims = McpTokenClaims {
        iss: settings.issuer(),
        sub: user_id.to_string(),
        aud: resource.to_string(),
        client_id: client_id.to_string(),
        scope: scopes.join(" "),
        grant: grant_id.to_string(),
        iat: now.timestamp(),
        exp: now.timestamp() + settings.mcp_access_token_ttl_sec,
        jti: new_id(),
    };
    let mut header = Header::new(Algorithm::HS256);
    header.typ = Some("at+jwt".into());
    let key = mcp_token_key(settings);
    let access = encode(&header, &claims, &EncodingKey::from_secret(&key))
        .map_err(|e| OAuthError::new("server_error", e.to_string(), 500))?;

    let refresh = token_urlsafe(40);
    let rt = RefreshToken {
        id: new_id(),
        created_at: now,
        updated_at: now,
        token_hash: sha256_hex(&refresh),
        grant_id: grant_id.to_string(),
        user_id: user_id.to_string(),
        client_id: client_id.to_string(),
        scopes: scopes.to_vec(),
        resource: resource.to_string(),
        expires_at: now + ChronoDuration::days(settings.mcp_refresh_token_ttl_days),
        used: false,
    };
    db.refresh_tokens
        .create(&rt)
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?;

    Ok(json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": settings.mcp_access_token_ttl_sec,
        "refresh_token": refresh,
        "scope": scopes.join(" "),
    }))
}

pub fn exchange_code(
    settings: &Settings,
    db: &Database,
    form: &HashMap<String, String>,
    client: &ClientInfo,
) -> Result<Value, OAuthError> {
    let raw_code = form.get("code").map(String::as_str).unwrap_or("");
    let raw_payload = db
        .engine
        .pop_oauth_code(&sha256_hex(raw_code))
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?
        .ok_or_else(|| OAuthError::bad("invalid_grant", "인가 코드가 없거나 만료되었습니다"))?;
    let code: AuthorizationCode = serde_json::from_str(&raw_payload)
        .map_err(|_| OAuthError::bad("invalid_grant", "인가 코드가 없거나 만료되었습니다"))?;

    if code.client_id != client.client_id {
        return Err(OAuthError::bad("invalid_grant", "인가 코드가 없거나 만료되었습니다"));
    }
    if form.get("redirect_uri").map(String::as_str) != Some(code.redirect_uri.as_str()) {
        return Err(OAuthError::bad("invalid_grant", "redirect_uri 가 인가 요청과 다릅니다"));
    }
    let verifier = form.get("code_verifier").map(String::as_str).unwrap_or("");
    if !pkce_ok(verifier, &code.code_challenge) {
        return Err(OAuthError::bad("invalid_grant", "PKCE code_verifier 가 맞지 않습니다"));
    }
    if normalize_resource(settings, form.get("resource").map(String::as_str))? != code.resource {
        return Err(OAuthError::bad("invalid_target", "resource 가 인가 요청과 다릅니다"));
    }
    if db
        .oauth_grants
        .get(&code.grant_id)
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?
        .is_none()
    {
        return Err(OAuthError::bad("invalid_grant", "연결이 해제되었습니다"));
    }
    issue_tokens(
        settings,
        db,
        &code.user_id,
        &code.grant_id,
        &client.client_id,
        &code.scopes,
        &code.resource,
    )
}

pub fn refresh_oauth_token(
    settings: &Settings,
    db: &Database,
    form: &HashMap<String, String>,
    client: &ClientInfo,
) -> Result<Value, OAuthError> {
    let token_hash = sha256_hex(form.get("refresh_token").map(String::as_str).unwrap_or(""));
    let mut rt = db
        .refresh_tokens
        .list()
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?
        .into_iter()
        .find(|t| t.token_hash == token_hash)
        .ok_or_else(|| OAuthError::bad("invalid_grant", "refresh_token 이 유효하지 않습니다"))?;
    if rt.client_id != client.client_id {
        return Err(OAuthError::bad("invalid_grant", "refresh_token 이 유효하지 않습니다"));
    }
    if rt.used {
        // Reuse detection -> revoke all refresh tokens for this grant
        for t in db
            .refresh_tokens
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|t| t.grant_id == rt.grant_id)
        {
            let _ = db.refresh_tokens.delete(&t.id);
        }
        return Err(OAuthError::bad(
            "invalid_grant",
            "이미 사용된 refresh_token 입니다 — 다시 로그인하세요",
        ));
    }
    let grant = db
        .oauth_grants
        .get(&rt.grant_id)
        .map_err(|_| OAuthError::new("server_error", "DB error", 500))?;
    let Some(grant) = grant else {
        return Err(OAuthError::bad(
            "invalid_grant",
            "refresh_token 이 만료되었거나 연결이 해제되었습니다",
        ));
    };
    if rt.expires_at <= Utc::now() {
        return Err(OAuthError::bad(
            "invalid_grant",
            "refresh_token 이 만료되었거나 연결이 해제되었습니다",
        ));
    }
    let grant_scopes: HashSet<&str> = grant.scopes.iter().map(String::as_str).collect();
    if !rt.scopes.iter().all(|s| grant_scopes.contains(s.as_str())) {
        return Err(OAuthError::bad(
            "invalid_grant",
            "연결 권한이 축소되어 refresh_token 을 사용할 수 없습니다",
        ));
    }
    let resource = match form.get("resource").map(String::as_str).filter(|s| !s.is_empty()) {
        Some(r) => normalize_resource(settings, Some(r))?,
        None => rt.resource.clone(),
    };
    if resource != rt.resource {
        return Err(OAuthError::bad("invalid_target", "resource 가 다릅니다"));
    }
    let mut scopes = rt.scopes.clone();
    if let Some(req_scope) = form.get("scope").map(String::as_str).filter(|s| !s.is_empty()) {
        let parsed = parse_scopes(Some(req_scope))?;
        let rt_set: HashSet<&str> = rt.scopes.iter().map(String::as_str).collect();
        if !parsed.iter().all(|s| rt_set.contains(s.as_str())) {
            return Err(OAuthError::bad("invalid_scope", "처음 허용한 범위를 넘을 수 없습니다"));
        }
        scopes = parsed;
    }
    rt.used = true;
    let _ = db.refresh_tokens.update(&rt);
    issue_tokens(
        settings,
        db,
        &rt.user_id,
        &rt.grant_id,
        &client.client_id,
        &scopes,
        &rt.resource,
    )
}

pub fn revoke_token(db: &Database, token: &str, client: &ClientInfo) {
    let token_hash = sha256_hex(token);
    for t in db
        .refresh_tokens
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t.token_hash == token_hash && t.client_id == client.client_id)
    {
        let _ = db.refresh_tokens.delete(&t.id);
    }
}

pub fn revoke_grant(db: &Database, grant_id: &str) {
    for t in db
        .refresh_tokens
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t.grant_id == grant_id)
    {
        let _ = db.refresh_tokens.delete(&t.id);
    }
    let _ = db.oauth_grants.delete(grant_id);
}

pub fn verify_access_token(settings: &Settings, db: &Database, token: &str) -> Option<McpTokenClaims> {
    let key = mcp_token_key(settings);
    let mut val = Validation::new(Algorithm::HS256);
    val.validate_exp = true;
    val.set_audience(&[settings.resource_url()]);
    val.set_issuer(&[settings.issuer()]);

    let data = decode::<McpTokenClaims>(token, &DecodingKey::from_secret(&key), &val).ok()?;
    let claims = data.claims;
    let mut grant = db.oauth_grants.get(&claims.grant).ok().flatten()?;
    if grant.user_id != claims.sub || db.users.get(&claims.sub).ok().flatten().is_none() {
        return None;
    }
    let grant_scopes: HashSet<&str> = grant.scopes.iter().map(String::as_str).collect();
    let token_scopes: Vec<&str> = claims.scope.split_whitespace().collect();
    if !token_scopes.iter().all(|s| grant_scopes.contains(s)) {
        return None;
    }
    let now = utcnow();
    if grant
        .last_used_at
        .is_none_or(|prev| (now - prev) > ChronoDuration::minutes(5))
    {
        grant.last_used_at = Some(now);
        let _ = db.oauth_grants.update(&grant);
    }
    Some(claims)
}
