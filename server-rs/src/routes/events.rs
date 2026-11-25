use std::convert::Infallible;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::error::ApiResult;
use crate::routes::deps::{require_project_access, AuthUser};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events", get(user_events))
        .route("/projects/{project_id}/events", get(project_events))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    since: Option<i64>,
    #[serde(default)]
    once: bool,
}

fn parse_cursor(headers: &HeaderMap, since: Option<i64>, state: &AppState) -> ApiResult<i64> {
    if let Some(s) = since {
        return Ok(s.max(0));
    }
    if let Some(val) = headers.get("last-event-id").and_then(|v| v.to_str().ok()) {
        if let Ok(n) = val.trim().parse::<i64>() {
            return Ok(n.max(0));
        }
    }
    Ok(state.db.latest_event_seq()?)
}

fn spawn_stream(
    state: AppState,
    channels: Vec<String>,
    mut cursor: i64,
    once: bool,
) -> impl IntoResponse {
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(64);
    let mut bus_rx = state.events.subscribe();

    tokio::spawn(async move {
        let pending = state
            .db
            .fetch_events(&channels, cursor, 200)
            .unwrap_or_default();
        if let Some((last_seq, _, _)) = pending.last() {
            cursor = *last_seq;
        }
        let connected = Event::default()
            .event("connected")
            .id(cursor.to_string())
            .data(json!({ "seq": cursor }).to_string());
        if tx.send(Ok(connected)).await.is_err() {
            return;
        }
        for (seq, kind, payload) in pending {
            let ev = Event::default()
                .event(kind)
                .id(seq.to_string())
                .data(payload.to_string());
            if tx.send(Ok(ev)).await.is_err() {
                return;
            }
        }
        if once {
            return;
        }

        let mut last_ping = Instant::now();
        let keepalive_sec = Duration::from_secs(20);

        loop {
            if tx.is_closed() {
                break;
            }
            let observed = state.events.latest_seq();
            if observed > cursor {
                let events = state
                    .db
                    .fetch_events(&channels, cursor, 200)
                    .unwrap_or_default();
                if !events.is_empty() {
                    for (seq, kind, payload) in events {
                        cursor = cursor.max(seq);
                        let ev = Event::default()
                            .event(kind)
                            .id(seq.to_string())
                            .data(payload.to_string());
                        if tx.send(Ok(ev)).await.is_err() {
                            return;
                        }
                    }
                    last_ping = Instant::now();
                    continue;
                }
                cursor = cursor.max(observed);
            }
            let remaining = keepalive_sec.saturating_sub(last_ping.elapsed());
            if remaining.is_zero() {
                if tx.send(Ok(Event::default().comment("keepalive"))).await.is_err() {
                    return;
                }
                last_ping = Instant::now();
                continue;
            }
            tokio::select! {
                _ = tx.closed() => break,
                _ = bus_rx.recv() => {},
                _ = tokio::time::sleep(remaining) => {},
            }
        }
    });

    let stream = ReceiverStream::new(rx);
    let sse = Sse::new(stream);
    (
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform")),
            (header::HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no")),
        ],
        sse,
    )
}

async fn project_events(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<EventsQuery>,
    headers: HeaderMap,
    AuthUser(user): AuthUser,
) -> ApiResult<impl IntoResponse> {
    let access = require_project_access(&state, &project_id, &user)?;
    let cursor = parse_cursor(&headers, q.since, &state)?;
    let channels = vec![access.project.id, format!("user:{}", user.id)];
    Ok(spawn_stream(state, channels, cursor, q.once))
}

async fn user_events(
    State(state): State<AppState>,
    Query(q): Query<EventsQuery>,
    headers: HeaderMap,
    AuthUser(user): AuthUser,
) -> ApiResult<impl IntoResponse> {
    let cursor = parse_cursor(&headers, q.since, &state)?;
    let channels = vec![format!("user:{}", user.id)];
    Ok(spawn_stream(state, channels, cursor, q.once))
}
