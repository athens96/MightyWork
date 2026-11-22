use std::net::SocketAddr;

use mightywork_server::config::Settings;
use mightywork_server::db::Database;
use mightywork_server::{create_app, AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let settings = Settings::from_env();
    if settings.jwt_secret == "change-me" {
        tracing::warn!("JWT_SECRET is the default value. Set a strong secret in .env before deploying.");
    }

    let db = Database::open(&settings.data_dir).expect("failed to open SQLite database");
    let addr: SocketAddr = format!("{}:{}", settings.host, settings.port)
        .parse()
        .expect("invalid bind address");
    let app = create_app(AppState::new(settings, db));

    tracing::info!("MightyWork Rust API listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind TCP listener");
    axum::serve(listener, app).await.expect("server error");
}
