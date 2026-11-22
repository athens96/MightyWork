use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::config::Settings;
use crate::error::{ApiError, ApiResult};
use crate::models::{utcnow, GoogleLoginRequest, TokenResponse, User};
use crate::routes::deps::{extract_cookie, AuthUser};
use crate::security::{create_access_token, create_refresh_token, decode_refresh_token};
use crate::AppState;

const REFRESH_COOKIE: &str = "mw_refresh";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/google", post(login_with_google))
        .route("/auth/refresh", post(refresh_session))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
}

fn build_refresh_cookie(user_id: &str, settings: &Settings) -> ApiResult<HeaderValue> {
    let token = create_refresh_token(user_id, settings).map_err(ApiError::internal)?;
    let max_age = settings.web_refresh_token_ttl_days * 86_400;
    let secure = if settings.public_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    let val = format!("{REFRESH_COOKIE}={token}; HttpOnly{secure}; SameSite=Lax; Path=/api/auth; Max-Age={max_age}");
    HeaderValue::from_str(&val).map_err(|e| ApiError::internal(e.to_string()))
}

async fn login_with_google(
    State(state): State<AppState>,
    Json(body): Json<GoogleLoginRequest>,
) -> ApiResult<Response> {
    let identity = (state.google_verifier)(&body.credential, &state.settings.google_client_id)
        .await
        .map_err(|_| ApiError::unauthorized("Invalid Google credential"))?;

    if !identity.email_verified {
        return Err(ApiError::forbidden("Email not verified"));
    }

    let domain = identity
        .email
        .rsplit('@')
        .next()
        .unwrap_or("")
        .to_lowercase();
    if !state.settings.allowed_email_domains.is_empty()
        && !state
            .settings
            .allowed_email_domains
            .iter()
            .any(|d| d.to_lowercase() == domain)
    {
        return Err(ApiError::forbidden("Email domain not allowed"));
    }

    let now = utcnow();
    let user = match state.db.users.get(&identity.sub)? {
        None => {
            let u = User {
                id: identity.sub,
                created_at: now,
                updated_at: now,
                email: identity.email,
                name: identity.name,
                picture: identity.picture,
                last_login_at: Some(now),
            };
            state.db.users.create(&u)?
        }
        Some(mut u) => {
            u.email = identity.email;
            u.name = identity.name;
            u.picture = identity.picture;
            u.last_login_at = Some(now);
            u.updated_at = now;
            state.db.users.update(&u)?;
            u
        }
    };

    let access_token = create_access_token(&user.id, &state.settings).map_err(ApiError::internal)?;
    let cookie = build_refresh_cookie(&user.id, &state.settings)?;
    let mut res = Json(TokenResponse {
        access_token,
        token_type: "bearer".into(),
        user,
    })
    .into_response();
    res.headers_mut().append(header::SET_COOKIE, cookie);
    Ok(res)
}

async fn refresh_session(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let raw = extract_cookie(&headers, REFRESH_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("Refresh token missing"))?;
    let user_id = decode_refresh_token(&raw, &state.settings)
        .map_err(|_| ApiError::unauthorized("Invalid refresh token"))?;
    let user = state
        .db
        .users
        .get(&user_id)?
        .ok_or_else(|| ApiError::unauthorized("User not found"))?;
    let access_token = create_access_token(&user.id, &state.settings).map_err(ApiError::internal)?;
    let cookie = build_refresh_cookie(&user.id, &state.settings)?;
    let mut res = Json(TokenResponse {
        access_token,
        token_type: "bearer".into(),
        user,
    })
    .into_response();
    res.headers_mut().append(header::SET_COOKIE, cookie);
    Ok(res)
}

async fn logout() -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static("mw_refresh=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0"),
    );
    res
}

async fn me(AuthUser(user): AuthUser) -> Json<User> {
    Json(user)
}
