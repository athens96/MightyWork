pub mod config;
pub mod db;
pub mod error;
pub mod models;
pub mod routes;
pub mod security;
pub mod services;

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::middleware;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

use crate::config::{Settings, APP_VERSION};
use crate::db::Database;
use crate::models::OAUTH_SCOPES;
use crate::routes::deps::security_headers;
use crate::security::{default_google_verifier, GoogleVerifierFn};
use crate::services::events::EventBus;
use crate::services::webhooks::WebhookSenderFn;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub db: Database,
    pub events: EventBus,
    pub google_verifier: GoogleVerifierFn,
    pub webhook_sender: Option<WebhookSenderFn>,
}

impl AppState {
    pub fn new(settings: Settings, db: Database) -> Self {
        let initial_seq = db.latest_event_seq().unwrap_or(0);
        Self {
            settings: Arc::new(settings),
            db,
            events: EventBus::with_seq(initial_seq),
            google_verifier: default_google_verifier(),
            webhook_sender: None,
        }
    }

    pub fn with_google_verifier(mut self, verifier: GoogleVerifierFn) -> Self {
        self.google_verifier = verifier;
        self
    }

    pub fn with_webhook_sender(mut self, sender: WebhookSenderFn) -> Self {
        self.webhook_sender = Some(sender);
        self
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": APP_VERSION }))
}

async fn version(State(state): State<AppState>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(json!({ "name": state.settings.app_name, "version": APP_VERSION })),
    )
}

async fn mcp_info(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "url": state.settings.resource_url(),
        "issuer": state.settings.issuer(),
        "scopes": OAUTH_SCOPES,
    }))
}

pub fn create_app(state: AppState) -> Router {
    let origins: Vec<HeaderValue> = state
        .settings
        .cors_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            HeaderName::from_static("mcp-session-id"),
            HeaderName::from_static("last-event-id"),
        ])
        .expose_headers([HeaderName::from_static("mcp-session-id")]);

    let api = Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route("/mcp-info", get(mcp_info))
        .merge(routes::auth::router())
        .merge(routes::users::router())
        .merge(routes::projects::router())
        .merge(routes::members::router())
        .merge(routes::notifications::router())
        .merge(routes::tasks::router())
        .merge(routes::comments::router())
        .merge(routes::wiki::router())
        .merge(routes::trash::router())
        .merge(routes::events::router())
        .merge(routes::knowledge::router())
        .merge(routes::knowledge_base::router())
        .merge(routes::cycles::router())
        .merge(routes::milestones::router())
        .merge(routes::releases::router())
        .merge(routes::triage::router())
        .merge(routes::views::router())
        .merge(routes::templates::router())
        .merge(routes::attachments::router())
        .merge(routes::export::router())
        .merge(routes::github::router())
        .merge(routes::webhooks::router())
        .merge(routes::oauth::api_router());

    Router::new()
        .nest("/api", api)
        .merge(routes::oauth::public_router())
        .merge(routes::mcp::router())
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(cors)
        .with_state(state)
}
