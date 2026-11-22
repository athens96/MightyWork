use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use mightywork_server::config::Settings;
use mightywork_server::db::Database;
use mightywork_server::security::{GoogleIdentity, GoogleVerifierFn};
use mightywork_server::{create_app, AppState};

fn mock_google_verifier() -> GoogleVerifierFn {
    Arc::new(|credential: &str, _client_id: &str| {
        let cred = credential.to_string();
        Box::pin(async move {
            match cred.as_str() {
                "alice-token" => Ok(GoogleIdentity {
                    sub: "google-sub-alice".into(),
                    email: "alice@example.com".into(),
                    email_verified: true,
                    name: "Alice".into(),
                    picture: Some("https://example.com/alice.png".into()),
                }),
                "bob-token" => Ok(GoogleIdentity {
                    sub: "google-sub-bob".into(),
                    email: "bob@example.com".into(),
                    email_verified: true,
                    name: "Bob".into(),
                    picture: None,
                }),
                "carol-token" => Ok(GoogleIdentity {
                    sub: "google-sub-carol".into(),
                    email: "carol@other.org".into(),
                    email_verified: true,
                    name: "Carol".into(),
                    picture: None,
                }),
                _ => Err("Invalid mock token".into()),
            }
        })
    })
}

struct TestApp {
    router: axum::Router,
    _dir: TempDir,
    db: Database,
    settings: Settings,
}

impl TestApp {
    fn new() -> Self {
        Self::with_settings(|_| {})
    }

    fn with_settings(customize: impl FnOnce(&mut Settings)) -> Self {
        let dir = TempDir::new().unwrap();
        let mut settings = Settings::from_env();
        settings.data_dir = dir.path().to_path_buf();
        settings.jwt_secret = "test-secret-0123456789abcdef".into();
        settings.google_client_id = "test-google-client-id".into();
        settings.allowed_email_domains = vec![];
        settings.public_url = "https://mightywork.test".into();
        customize(&mut settings);
        let db = Database::open(&settings.data_dir.join("mightywork.db")).unwrap();
        let state = AppState::new(settings.clone(), db.clone())
            .with_google_verifier(mock_google_verifier());
        let router = create_app(state);
        Self {
            router,
            _dir: dir,
            db,
            settings,
        }
    }

    async fn req(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
        extra_headers: &[(&str, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(tok) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {tok}"));
        }
        for (k, v) in extra_headers {
            builder = builder.header(*k, *v);
        }
        let req = if let Some(b) = body {
            builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string()))
                .unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        };
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
        };
        (status, headers, json)
    }

    async fn login(&self, credential: &str) -> (String, Value, axum::http::HeaderMap) {
        let (status, headers, body) = self
            .req(
                Method::POST,
                "/api/auth/google",
                None,
                Some(json!({ "credential": credential })),
                &[],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "login failed: {body}");
        let token = body["access_token"].as_str().unwrap().to_string();
        (token, body["user"].clone(), headers)
    }
}

#[tokio::test]
async fn health_version_mcp_info_and_security_headers() {
    let app = TestApp::new();
    let (status, headers, body) = app.req(Method::GET, "/api/health", None, None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
    assert_eq!(headers.get("referrer-policy").unwrap(), "strict-origin-when-cross-origin");

    let (status, headers, body) = app.req(Method::GET, "/api/version", None, None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["name"], "MightyWork");
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");

    let (status, _, body) = app.req(Method::GET, "/api/mcp-info", None, None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["url"], "https://mightywork.test/mcp");
    assert_eq!(body["issuer"], "https://mightywork.test");
}

#[tokio::test]
async fn auth_google_refresh_logout_and_domain_restriction() {
    let app = TestApp::with_settings(|s| {
        s.allowed_email_domains = vec!["example.com".into()];
    });

    // Disallowed domain
    let (status, _, _) = app
        .req(
            Method::POST,
            "/api/auth/google",
            None,
            Some(json!({ "credential": "carol-token" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Allowed domain
    let (token, user, headers) = app.login("alice-token").await;
    assert_eq!(user["email"], "alice@example.com");
    let set_cookie = headers
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(set_cookie.contains("mw_refresh="));
    assert!(set_cookie.contains("HttpOnly"));
    let cookie_pair = set_cookie.split(';').next().unwrap().to_string();

    // /auth/me works with bearer
    let (status, _, me) = app.req(Method::GET, "/api/auth/me", Some(&token), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], user["id"]);

    // /auth/refresh works with cookie
    let (status, headers2, refreshed) = app
        .req(
            Method::POST,
            "/api/auth/refresh",
            None,
            None,
            &[("cookie", &cookie_pair)],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(refreshed["access_token"].as_str().is_some());
    assert!(headers2.get(header::SET_COOKIE).is_some());

    // /auth/logout clears cookie
    let (status, headers3, _) = app.req(Method::POST, "/api/auth/logout", None, None, &[]).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(headers3
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
}

#[tokio::test]
async fn projects_members_rbac_and_ownership_transfer() {
    let app = TestApp::new();
    let (alice_tok, alice, _) = app.login("alice-token").await;
    let (bob_tok, bob, _) = app.login("bob-token").await;
    let alice_id = alice["id"].as_str().unwrap();
    let bob_id = bob["id"].as_str().unwrap();

    // Create project
    let (status, _, proj) = app
        .req(
            Method::POST,
            "/api/projects",
            Some(&alice_tok),
            Some(json!({ "name": "Alpha", "key": "alp", "description": "desc" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(proj["key"], "ALP");
    let pid = proj["id"].as_str().unwrap();

    // Duplicate key rejected
    let (status, _, _) = app
        .req(
            Method::POST,
            "/api/projects",
            Some(&alice_tok),
            Some(json!({ "name": "Alpha 2", "key": "ALP" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Bob cannot see Alice's project (404 to avoid leaking project existence)
    let (status, _, _) = app
        .req(Method::GET, &format!("/api/projects/{pid}"), Some(&bob_tok), None, &[])
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Alice invites Bob with view-only permission
    let (status, _, member) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/members"),
            Some(&alice_tok),
            Some(json!({ "email": "bob@example.com", "permissions": ["view"] })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(member["user"]["id"], bob_id);
    let mid = member["id"].as_str().unwrap();

    // Bob can view but not create tasks
    let (status, _, _) = app
        .req(Method::GET, &format!("/api/projects/{pid}/tasks"), Some(&bob_tok), None, &[])
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/tasks"),
            Some(&bob_tok),
            Some(json!({ "title": "Nope" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Promote Bob to admin, transfer ownership, verify audit logs
    let (status, _, _) = app
        .req(
            Method::PATCH,
            &format!("/api/projects/{pid}/members/{mid}"),
            Some(&alice_tok),
            Some(json!({ "permissions": ["admin"] })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, transferred) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/transfer-ownership"),
            Some(&alice_tok),
            Some(json!({ "new_owner_user_id": bob_id })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(transferred["created_by"], bob_id);
    assert_ne!(alice_id, bob_id);

    let (status, _, logs) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/audit-logs"),
            Some(&bob_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(logs
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["action"] == "project.ownership_transferred"));
}

#[tokio::test]
async fn tasks_lifecycle_bulk_move_links_comments_reactions_notifications() {
    let app = TestApp::new();
    let (alice_tok, alice, _) = app.login("alice-token").await;
    let (bob_tok, bob, _) = app.login("bob-token").await;
    let bob_id = bob["id"].as_str().unwrap();

    // Create two projects
    let (_, _, p1) = app
        .req(
            Method::POST,
            "/api/projects",
            Some(&alice_tok),
            Some(json!({ "name": "One", "key": "ONE" })),
            &[],
        )
        .await;
    let p1_id = p1["id"].as_str().unwrap();

    let (_, _, p2) = app
        .req(
            Method::POST,
            "/api/projects",
            Some(&alice_tok),
            Some(json!({ "name": "Two", "key": "TWO" })),
            &[],
        )
        .await;
    let p2_id = p2["id"].as_str().unwrap();

    // Add Bob to p1 as member
    app.req(
        Method::POST,
        &format!("/api/projects/{p1_id}/members"),
        Some(&alice_tok),
        Some(json!({ "email": "bob@example.com", "permissions": ["view", "create", "edit"] })),
        &[],
    )
    .await;

    // Create task 1 & task 2
    let (status, _, t1) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks"),
            Some(&alice_tok),
            Some(json!({
                "title": "First task",
                "assignee_id": bob_id,
                "version": "v1.0.0",
                "tags": ["backend", "v1.0.0"],
                "start_date": "2026-01-01",
                "due_date": "2026-01-10"
            })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(t1["number"], 1);
    assert_eq!(t1["version"], "v1.0.0");
    let t1_id = t1["id"].as_str().unwrap();

    // Invalid date range rejected with 422
    let (status, _, _) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks"),
            Some(&alice_tok),
            Some(json!({
                "title": "Bad dates",
                "start_date": "2026-02-10",
                "due_date": "2026-02-01"
            })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // PATCH explicitly clearing version and assignee_id to null while keeping title
    let (status, _, t1_patched) = app
        .req(
            Method::PATCH,
            &format!("/api/projects/{p1_id}/tasks/{t1_id}"),
            Some(&alice_tok),
            Some(json!({ "version": null, "assignee_id": null, "stage": "in_progress" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(t1_patched["version"].is_null());
    assert!(t1_patched["assignee_id"].is_null());
    assert_eq!(t1_patched["stage"], "in_progress");
    assert_eq!(t1_patched["title"], "First task");

    // Create blocking task & link
    let (_, _, t2) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks"),
            Some(&alice_tok),
            Some(json!({ "title": "Blocker", "stage": "todo" })),
            &[],
        )
        .await;
    let t2_id = t2["id"].as_str().unwrap();

    let (status, _, link) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks/{t2_id}/links"),
            Some(&alice_tok),
            Some(json!({ "target_id": t1_id, "kind": "blocks" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(link["kind"], "blocks");

    // List tasks shows blocked_by_count=1 on t1
    let (_, _, list) = app
        .req(Method::GET, &format!("/api/projects/{p1_id}/tasks"), Some(&alice_tok), None, &[])
        .await;
    let t1_in_list = list.as_array().unwrap().iter().find(|x| x["id"] == t1_id).unwrap();
    assert_eq!(t1_in_list["blocked_by_count"], 1);

    // Watch task & add comment mentioning Bob + react
    let (status, _, watch) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks/{t1_id}/watch"),
            Some(&bob_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(watch["watcher_ids"][0], bob_id);

    let (status, _, comment) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks/{t1_id}/comments"),
            Some(&alice_tok),
            Some(json!({ "body": "Hey @Bob please check ONE-1" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let cid = comment["id"].as_str().unwrap();

    // Reaction toggle
    let (status, _, reacted) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks/{t1_id}/comments/{cid}/reactions"),
            Some(&bob_tok),
            Some(json!({ "emoji": "👍" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reacted["reactions"]["👍"][0], bob_id);

    // Bob received notification for mention
    let (_, _, notifs) = app
        .req(Method::GET, "/api/notifications", Some(&bob_tok), None, &[])
        .await;
    assert!(notifs["unread_count"].as_u64().unwrap() >= 1);
    assert!(!notifs["items"].as_array().unwrap().is_empty());

    // Duplicate task
    let (status, _, dup) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks/{t1_id}/duplicate"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(dup["title"], "First task (복사)");

    // Move task t1 to project p2
    let (status, _, moved) = app
        .req(
            Method::POST,
            &format!("/api/projects/{p1_id}/tasks/{t1_id}/move"),
            Some(&alice_tok),
            Some(json!({ "target_project_id": p2_id })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(moved["project_id"], p2_id);
    assert_eq!(moved["number"], 1);

    // Comment moved with task!
    let (_, _, moved_comments) = app
        .req(
            Method::GET,
            &format!("/api/projects/{p2_id}/tasks/{t1_id}/comments"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(moved_comments.as_array().unwrap().len(), 1);

    // Bulk update + custom pipeline
    let (status, _, pipe) = app
        .req(
            Method::PUT,
            &format!("/api/projects/{p1_id}/pipeline"),
            Some(&alice_tok),
            Some(json!({
                "stages": [
                    { "key": "backlog", "label": "Backlog", "color": "#64748b", "hidden": false },
                    { "key": "todo", "label": "To Do", "color": "#3b82f6", "hidden": false },
                    { "key": "in_progress", "label": "Doing", "color": "#f59e0b", "hidden": false },
                    { "key": "review", "label": "Review", "color": "#8b5cf6", "hidden": true },
                    { "key": "qa", "label": "QA", "color": "#ec4899", "hidden": true },
                    { "key": "done", "label": "Shipped", "color": "#10b981", "hidden": false }
                ]
            })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pipe.as_array().unwrap().len(), 6);
    assert_eq!(pipe[5]["label"], "Shipped");
    assert_eq!(alice["name"], "Alice");
}

#[tokio::test]
async fn wiki_optimistic_lock_revisions_rename_propagation_and_trash() {
    let app = TestApp::new();
    let (alice_tok, _, _) = app.login("alice-token").await;

    let (_, _, proj) = app
        .req(
            Method::POST,
            "/api/projects",
            Some(&alice_tok),
            Some(json!({ "name": "WikiProj", "key": "WIK" })),
            &[],
        )
        .await;
    let pid = proj["id"].as_str().unwrap();

    // Create two pages: Target and Referrer linking [[Target]] and [[Broken]]
    let (_, _, p_target) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/pages"),
            Some(&alice_tok),
            Some(json!({
                "title": "Target",
                "content": "Line 1\nLine 2",
                "status": "published",
                "doc_type": "spec"
            })),
            &[],
        )
        .await;
    let target_id = p_target["id"].as_str().unwrap();
    let target_updated = p_target["updated_at"].as_str().unwrap();

    let (_, _, p_ref) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/pages"),
            Some(&alice_tok),
            Some(json!({
                "title": "Referrer",
                "content": "See [[Target]] and [[Missing Page]]"
            })),
            &[],
        )
        .await;
    let ref_id = p_ref["id"].as_str().unwrap();

    // List pages shows backlink_count=1 on Target, broken_link_count=1 on Referrer
    let (_, _, pages) = app
        .req(Method::GET, &format!("/api/projects/{pid}/wiki/pages"), Some(&alice_tok), None, &[])
        .await;
    let list = pages.as_array().unwrap();
    let t_row = list.iter().find(|p| p["id"] == target_id).unwrap();
    let r_row = list.iter().find(|p| p["id"] == ref_id).unwrap();
    assert_eq!(t_row["backlink_count"], 1);
    assert_eq!(r_row["broken_link_count"], 1);

    // Stale expected_updated_at returns 409 Conflict
    let (status, _, _) = app
        .req(
            Method::PATCH,
            &format!("/api/projects/{pid}/wiki/pages/{target_id}"),
            Some(&alice_tok),
            Some(json!({ "content": "Stale", "expected_updated_at": "2000-01-01T00:00:00Z" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Rename Target -> Renamed Target with matching expected_updated_at
    let (status, _, _) = app
        .req(
            Method::PATCH,
            &format!("/api/projects/{pid}/wiki/pages/{target_id}"),
            Some(&alice_tok),
            Some(json!({
                "title": "Renamed Target",
                "content": "Line 1\nLine 2 edited",
                "expected_updated_at": target_updated
            })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Verify link propagation updated Referrer's [[Target]] -> [[Renamed Target]]
    let (_, _, ref_after) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{ref_id}"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert!(ref_after["content"].as_str().unwrap().contains("[[Renamed Target]]"));

    // Revisions list & diff & restore
    let (_, _, revs) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{target_id}/revisions"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    let revs_arr = revs.as_array().unwrap();
    assert!(revs_arr.len() >= 2);
    let rev1_id = revs_arr.last().unwrap()["id"].as_str().unwrap();

    let (status, _, rev_detail) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{target_id}/revisions/{rev1_id}"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rev_detail["title"], "Target");

    let (status, _, restored) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/pages/{target_id}/revisions/{rev1_id}/restore"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored["title"], "Target");
    assert_eq!(restored["content"], "Line 1\nLine 2");

    // Soft-delete -> appears in trash -> hidden from GET -> restore -> visible again -> delete -> permanent purge
    let (status, _, _) = app
        .req(
            Method::DELETE,
            &format!("/api/projects/{pid}/wiki/pages/{ref_id}"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, _) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{ref_id}"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, trash) = app
        .req(Method::GET, &format!("/api/projects/{pid}/trash"), Some(&alice_tok), None, &[])
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(trash.as_array().unwrap().len(), 1);
    assert_eq!(trash[0]["kind"], "wiki");

    let (status, _, _) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/trash/wiki/{ref_id}/restore"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{ref_id}"),
            Some(&alice_tok),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Soft delete + empty trash
    app.req(
        Method::DELETE,
        &format!("/api/projects/{pid}/wiki/pages/{ref_id}"),
        Some(&alice_tok),
        None,
        &[],
    )
    .await;
    let (status, _, empty) = app
        .req(Method::POST, &format!("/api/projects/{pid}/trash/empty"), Some(&alice_tok), None, &[])
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["purged"], 1);
}

#[tokio::test]
async fn python_sqlite_schema_and_jwt_interoperability() {
    let app = TestApp::new();
    // Insert raw rows using exact Python SQLite JSON schema format
    app.db.engine.with_conn(|conn| {
        conn.execute(
            "INSERT INTO users (id, project_id, data) VALUES (?1, NULL, ?2)",
            rusqlite::params![
                "py-user-1",
                json!({
                    "id": "py-user-1",
                    "email": "py@example.com",
                    "name": "Python User",
                    "picture": null,
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00"
                }).to_string()
            ],
        )?;
        conn.execute(
            "INSERT INTO projects (id, project_id, data) VALUES (?1, NULL, ?2)",
            rusqlite::params![
                "py-proj-1",
                json!({
                    "id": "py-proj-1",
                    "name": "Legacy Python Project",
                    "key": "PYP",
                    "description": "Loaded from Python DB",
                    "created_by": "py-user-1",
                    "task_seq": 42,
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00"
                }).to_string()
            ],
        )?;
        conn.execute(
            "INSERT INTO tasks (id, project_id, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                "py-task-1",
                "py-proj-1",
                json!({
                    "id": "py-task-1",
                    "project_id": "py-proj-1",
                    "number": 42,
                    "title": "Existing Task",
                    "description": "From Python",
                    "stage": "in_progress",
                    "priority": "high",
                    "tags": ["legacy"],
                    "version": "v2.0",
                    "created_by": "py-user-1",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00"
                }).to_string()
            ],
        )?;
        Ok(())
    }).unwrap();

    // Sign JWT using same HS256 secret as Python security.py
    let tok = mightywork_server::security::create_access_token("py-user-1", &app.settings).unwrap();

    let (status, _, projects) = app.req(Method::GET, "/api/projects", Some(&tok), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(projects[0]["key"], "PYP");

    let (status, _, tasks) = app
        .req(Method::GET, "/api/projects/py-proj-1/tasks", Some(&tok), None, &[])
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tasks[0]["number"], 42);
    assert_eq!(tasks[0]["version"], "v2.0");

    // Next allocated task number must be 43!
    let (status, _, new_task) = app
        .req(
            Method::POST,
            "/api/projects/py-proj-1/tasks",
            Some(&tok),
            Some(json!({ "title": "Next in Rust" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(new_task["number"], 43);
}
