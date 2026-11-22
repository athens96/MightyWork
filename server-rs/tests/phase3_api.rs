use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

use mightywork_server::config::Settings;
use mightywork_server::db::Database;
use mightywork_server::security::{GoogleIdentity, GoogleVerifierFn};
use mightywork_server::services::webhooks::WebhookSenderFn;
use mightywork_server::{create_app, AppState};

type HmacSha256 = Hmac<Sha256>;

fn mock_google() -> GoogleVerifierFn {
    Arc::new(|cred: &str, _| {
        let c = cred.to_string();
        Box::pin(async move {
            match c.as_str() {
                "alice-token" => Ok(GoogleIdentity {
                    sub: "sub-alice".into(),
                    email: "alice@example.com".into(),
                    email_verified: true,
                    name: "Alice".into(),
                    picture: None,
                }),
                _ => Err("Invalid".into()),
            }
        })
    })
}

struct CapturedHook {
    url: String,
    body: String,
    headers: HashMap<String, String>,
}

struct TestApp {
    router: axum::Router,
    _dir: TempDir,
    captured: Arc<Mutex<Vec<CapturedHook>>>,
}

impl TestApp {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let mut settings = Settings::from_env();
        settings.data_dir = dir.path().to_path_buf();
        settings.jwt_secret = "phase3-secret-0123456789abcdef".into();
        settings.google_client_id = "test-cid".into();
        settings.allowed_email_domains = vec![];
        settings.public_url = "https://mightywork.test".into();
        settings.app_url = "https://mightywork.test".into();

        let captured: Arc<Mutex<Vec<CapturedHook>>> = Arc::new(Mutex::new(Vec::new()));
        let cap_c = captured.clone();
        let sender: WebhookSenderFn = Arc::new(move |url, raw, headers| {
            cap_c.lock().unwrap().push(CapturedHook {
                url: url.to_string(),
                body: String::from_utf8_lossy(raw).into_owned(),
                headers: headers.clone(),
            });
            Ok(200)
        });

        let db = Database::open(&settings.data_dir).unwrap();
        let state = AppState::new(settings, db)
            .with_google_verifier(mock_google())
            .with_webhook_sender(sender);
        Self {
            router: create_app(state),
            _dir: dir,
            captured,
        }
    }

    async fn raw(
        &self,
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
        body: Vec<u8>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut b = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let req = b.body(Body::from(body)).unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let st = resp.status();
        let hm = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
        (st, hm, bytes)
    }

    async fn json_req(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut hdrs = Vec::new();
        let auth_val;
        if let Some(t) = token {
            auth_val = format!("Bearer {t}");
            hdrs.push(("authorization", auth_val.as_str()));
        }
        let bytes = if let Some(v) = body {
            hdrs.push(("content-type", "application/json"));
            v.to_string().into_bytes()
        } else {
            vec![]
        };
        let (st, _, out) = self.raw(method, uri, &hdrs, bytes).await;
        let val = if out.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&out)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&out).into()))
        };
        (st, val)
    }

    async fn setup(&self) -> (String, String) {
        let (st, auth) = self
            .json_req(
                Method::POST,
                "/api/auth/google",
                None,
                Some(json!({ "credential": "alice-token" })),
            )
            .await;
        assert_eq!(st, StatusCode::OK);
        let tok = auth["access_token"].as_str().unwrap().to_string();
        let (st, proj) = self
            .json_req(
                Method::POST,
                "/api/projects",
                Some(&tok),
                Some(json!({ "name": "MightyWork", "key": "MW" })),
            )
            .await;
        assert_eq!(st, StatusCode::CREATED);
        (tok, proj["id"].as_str().unwrap().to_string())
    }
}

fn sign_gh(secret: &str, body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

#[tokio::test]
async fn github_integration_and_project_webhooks() {
    let app = TestApp::new();
    let (tok, pid) = app.setup().await;

    // Create task MW-1
    let (_, task) = app
        .json_req(
            Method::POST,
            &format!("/api/projects/{pid}/tasks"),
            Some(&tok),
            Some(json!({ "title": "Rust migration", "stage": "backlog", "tags": ["rust"] })),
        )
        .await;
    let tid = task["id"].as_str().unwrap();

    // Configure GitHub integration
    let (st, cfg) = app
        .json_req(
            Method::PUT,
            &format!("/api/projects/{pid}/github"),
            Some(&tok),
            Some(json!({ "repo": "athens96/MightyWork", "auto_transition": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let secret = cfg["generated_secret"].as_str().unwrap().to_string();

    // Invalid signature -> 401
    let push_payload = json!({
        "ref": "refs/heads/feat/MW-1-rust",
        "repository": { "full_name": "athens96/MightyWork" },
        "commits": [{
            "id": "abcdef1234567890",
            "message": "MW-1 implement phase 3",
            "url": "https://github.com/athens96/MightyWork/commit/abcdef1",
            "author": { "username": "athens96" }
        }]
    });
    let push_bytes = push_payload.to_string().into_bytes();
    let (st, _, _) = app
        .raw(
            Method::POST,
            "/api/webhooks/github",
            &[
                ("content-type", "application/json"),
                ("x-github-event", "push"),
                ("x-hub-signature-256", "sha256=deadbeef"),
            ],
            push_bytes.clone(),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    // Valid push -> transitions MW-1 backlog -> in_progress
    let sig = sign_gh(&secret, &push_bytes);
    let (st, _, out) = app
        .raw(
            Method::POST,
            "/api/webhooks/github",
            &[
                ("content-type", "application/json"),
                ("x-github-event", "push"),
                ("x-hub-signature-256", &sig),
            ],
            push_bytes,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let push_res: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(push_res["matched"], 1);

    let (_, t_after_push) = app
        .json_req(Method::GET, &format!("/api/projects/{pid}/tasks/{tid}"), Some(&tok), None)
        .await;
    assert_eq!(t_after_push["stage"], "in_progress");

    // PR opened -> transitions -> review
    let pr_open = json!({
        "action": "opened",
        "repository": { "full_name": "athens96/MightyWork" },
        "pull_request": {
            "number": 99,
            "title": "MW-1 Rust server",
            "body": "Completes MW-1",
            "state": "open",
            "merged": false,
            "html_url": "https://github.com/athens96/MightyWork/pull/99",
            "head": { "ref": "feat/mw-1" },
            "user": { "login": "athens96" }
        }
    })
    .to_string()
    .into_bytes();
    let sig_pr = sign_gh(&secret, &pr_open);
    let (st, _, _) = app
        .raw(
            Method::POST,
            "/api/webhooks/github",
            &[
                ("content-type", "application/json"),
                ("x-github-event", "pull_request"),
                ("x-hub-signature-256", &sig_pr),
            ],
            pr_open,
        )
        .await;
    assert_eq!(st, StatusCode::OK);

    let (_, t_after_pr) = app
        .json_req(Method::GET, &format!("/api/projects/{pid}/tasks/{tid}"), Some(&tok), None)
        .await;
    assert_eq!(t_after_pr["stage"], "review");

    // PR merged -> transitions -> done
    let pr_merged = json!({
        "action": "closed",
        "repository": { "full_name": "athens96/MightyWork" },
        "pull_request": {
            "number": 99,
            "title": "MW-1 Rust server",
            "body": "",
            "state": "closed",
            "merged": true,
            "html_url": "https://github.com/athens96/MightyWork/pull/99",
            "head": { "ref": "feat/mw-1" },
            "user": { "login": "athens96" }
        }
    })
    .to_string()
    .into_bytes();
    let sig_m = sign_gh(&secret, &pr_merged);
    app.raw(
        Method::POST,
        "/api/webhooks/github",
        &[
            ("content-type", "application/json"),
            ("x-github-event", "pull_request"),
            ("x-hub-signature-256", &sig_m),
        ],
        pr_merged,
    )
    .await;

    let (_, t_done) = app
        .json_req(Method::GET, &format!("/api/projects/{pid}/tasks/{tid}"), Some(&tok), None)
        .await;
    assert_eq!(t_done["stage"], "done");

    let (_, gh_links) = app
        .json_req(
            Method::GET,
            &format!("/api/projects/{pid}/tasks/{tid}/github"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(gh_links.as_array().unwrap().len(), 2);

    // Outbound webhooks: reject loopback SSRF
    let (st, _) = app
        .json_req(
            Method::POST,
            &format!("/api/projects/{pid}/webhooks"),
            Some(&tok),
            Some(json!({ "name": "Bad", "url": "https://127.0.0.1/hook" })),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // Create custom webhook & test delivery
    let (st, hook) = app
        .json_req(
            Method::POST,
            &format!("/api/projects/{pid}/webhooks"),
            Some(&tok),
            Some(json!({
                "name": "Agent Hook",
                "url": "https://hooks.example.com/mw",
                "preset": "custom",
                "events": ["task.created", "task.stage_changed"],
                "trigger_tags": ["rust"]
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    assert!(hook["generated_secret"].as_str().is_some());
    let wid = hook["id"].as_str().unwrap();

    let (st, deliv) = app
        .json_req(
            Method::POST,
            &format!("/api/projects/{pid}/webhooks/{wid}/test"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(deliv["ok"], true);
    assert_eq!(deliv["status_code"], 200);
    {
        let cap = app.captured.lock().unwrap();
        assert_eq!(cap.len(), 1);
        assert_eq!(cap[0].url, "https://hooks.example.com/mw");
        assert!(cap[0].body.contains("웹훅 테스트 발송"));
        assert!(cap[0].headers.contains_key("X-MightyWork-Signature-256"));
    }

    let (st, deliveries) = app
        .json_req(
            Method::GET,
            &format!("/api/projects/{pid}/webhooks/{wid}/deliveries"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(deliveries.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn oauth21_dcr_pkce_refresh_rotation_and_mcp_19_tools_e2e() {
    let app = TestApp::new();
    let (web_tok, _pid) = app.setup().await;

    // 1) Discovery endpoints & icon
    let (st, as_meta) = app
        .json_req(Method::GET, "/.well-known/oauth-authorization-server", None, None)
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(as_meta["issuer"], "https://mightywork.test/");
    assert_eq!(as_meta["client_id_metadata_document_supported"], true);

    let (st, prm) = app
        .json_req(Method::GET, "/.well-known/oauth-protected-resource/mcp", None, None)
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(prm["resource"], "https://mightywork.test/mcp");
    assert_eq!(prm["authorization_servers"][0], "https://mightywork.test/");

    let (st, hdrs, png) = app.raw(Method::GET, "/icon.png", &[], vec![]).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get(header::CONTENT_TYPE).unwrap(), "image/png");
    assert!(png.starts_with(b"\x89PNG"));

    // 2) DCR register
    let (st, dcr) = app
        .json_req(
            Method::POST,
            "/oauth/register",
            None,
            Some(json!({
                "client_name": "Antigravity Test CLI",
                "redirect_uris": ["http://127.0.0.1:43210/callback"],
                "token_endpoint_auth_method": "none"
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let client_id = dcr["client_id"].as_str().unwrap().to_string();

    // 3) PKCE S256 authorize -> redirect to consent
    let verifier = "v".repeat(64);
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(h.finalize());

    let auth_uri = format!(
        "/oauth/authorize?client_id={}&redirect_uri={}&response_type=code&code_challenge={}&code_challenge_method=S256&scope={}&state=xyz&resource={}",
        urlencoding::encode(&client_id),
        urlencoding::encode("http://127.0.0.1:43210/callback"),
        urlencoding::encode(&challenge),
        urlencoding::encode("mightywork:read mightywork:write"),
        urlencoding::encode("https://mightywork.test/mcp"),
    );
    let (st, hdrs, _) = app.raw(Method::GET, &auth_uri, &[], vec![]).await;
    assert!(st.is_redirection());
    let loc = hdrs.get(header::LOCATION).unwrap().to_str().unwrap();
    let req_id = loc.split("request=").nth(1).unwrap().to_string();

    // 4) Consent fetch & approve
    let (st, consent) = app
        .json_req(
            Method::GET,
            &format!("/api/oauth/requests/{req_id}"),
            Some(&web_tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(consent["client_name"], "Antigravity Test CLI");

    let (st, dec) = app
        .json_req(
            Method::POST,
            &format!("/api/oauth/requests/{req_id}/decision"),
            Some(&web_tok),
            Some(json!({ "approve": true, "scopes": ["mightywork:read", "mightywork:write"] })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let redirect_to = dec["redirect_to"].as_str().unwrap();
    assert!(redirect_to.contains("state=xyz"));
    assert!(redirect_to.contains("iss=https%3A%2F%2Fmightywork.test%2F"));
    let code = redirect_to
        .split("code=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();

    // 5) Exchange code -> access + refresh token
    let form_body = format!(
        "grant_type=authorization_code&code={}&client_id={}&redirect_uri={}&code_verifier={}&resource={}",
        urlencoding::encode(&code),
        urlencoding::encode(&client_id),
        urlencoding::encode("http://127.0.0.1:43210/callback"),
        urlencoding::encode(&verifier),
        urlencoding::encode("https://mightywork.test/mcp"),
    );
    let (st, _, out) = app
        .raw(
            Method::POST,
            "/oauth/token",
            &[("content-type", "application/x-www-form-urlencoded")],
            form_body.into_bytes(),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "token resp: {}", String::from_utf8_lossy(&out));
    let tok_resp: Value = serde_json::from_slice(&out).unwrap();
    let mcp_tok = tok_resp["access_token"].as_str().unwrap().to_string();
    let rt1 = tok_resp["refresh_token"].as_str().unwrap().to_string();

    // 6) Refresh rotation + reuse detection
    let ref_body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding::encode(&rt1),
        urlencoding::encode(&client_id),
    );
    let (st, _, out2) = app
        .raw(
            Method::POST,
            "/oauth/token",
            &[("content-type", "application/x-www-form-urlencoded")],
            ref_body.clone().into_bytes(),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let tok2: Value = serde_json::from_slice(&out2).unwrap();
    assert_ne!(tok2["refresh_token"], rt1);

    // Reusing rt1 triggers reuse detection (400)
    let (st, _, _) = app
        .raw(
            Method::POST,
            "/oauth/token",
            &[("content-type", "application/x-www-form-urlencoded")],
            ref_body.into_bytes(),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 7) Unauthenticated /mcp -> 401 with RFC 9728 WWW-Authenticate
    let (st, hdrs, _) = app
        .raw(
            Method::POST,
            "/mcp",
            &[("content-type", "application/json")],
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string().into_bytes(),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert!(hdrs
        .get(header::WWW_AUTHENTICATE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("oauth-protected-resource/mcp"));

    // 8) Authenticated MCP initialize + tools/list (all 19 tools!) + tools/call E2E
    let (st, init) = app
        .json_req(
            Method::POST,
            "/mcp",
            Some(&mcp_tok),
            Some(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }
            })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(init["result"]["serverInfo"]["name"], "MightyWork");

    let (st, listed) = app
        .json_req(
            Method::POST,
            "/mcp",
            Some(&mcp_tok),
            Some(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 19);

    let call_tool = |name: &'static str, args: Value| {
        let app_ref = &app;
        let tok_ref = mcp_tok.clone();
        async move {
            let (st, resp) = app_ref
                .json_req(
                    Method::POST,
                    "/mcp",
                    Some(&tok_ref),
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": 10,
                        "method": "tools/call",
                        "params": { "name": name, "arguments": args }
                    })),
                )
                .await;
            assert_eq!(st, StatusCode::OK);
            assert_eq!(resp["result"]["isError"], false, "tool {name} failed: {resp}");
            let text = resp["result"]["content"][0]["text"].as_str().unwrap();
            serde_json::from_str::<Value>(text).unwrap()
        }
    };

    let projs = call_tool("list_projects", json!({})).await;
    assert_eq!(projs[0]["key"], "MW");

    let cyc = call_tool(
        "create_cycle",
        json!({ "project": "MW", "name": "Cycle 1", "start_date": "2026-01-01", "end_date": "2026-01-14", "status": "active" }),
    )
    .await;
    assert_eq!(cyc["name"], "Cycle 1");

    let ms = call_tool("create_milestone", json!({ "project": "MW", "name": "v1 Launch" })).await;
    assert_eq!(ms["name"], "v1 Launch");

    let t1 = call_tool(
        "create_task",
        json!({
            "project": "MW",
            "title": "MCP Created Task",
            "version": "v1.0.0",
            "cycle": "Cycle 1",
            "milestone": "v1 Launch",
            "checklist": ["Step A", "Step B"]
        }),
    )
    .await;
    assert_eq!(t1["key"], "MW-1");

    let t1_upd = call_tool(
        "update_task",
        json!({ "project": "MW", "task": "MW-1", "stage": "done", "check_items": ["Step A"] }),
    )
    .await;
    assert_eq!(t1_upd["stage"], "done");
    assert_eq!(t1_upd["checklist"][0]["done"], true);

    let t2 = call_tool("create_task", json!({ "project": "MW", "title": "Second Task" })).await;
    assert_eq!(t2["key"], "MW-2");

    let link = call_tool(
        "link_tasks",
        json!({ "project": "MW", "source_task": "MW-1", "target_task": "MW-2", "kind": "blocks" }),
    )
    .await;
    assert_eq!(link["kind"], "blocks");

    let commented = call_tool(
        "add_comment",
        json!({ "project": "MW", "task": "MW-1", "body": "Done via Rust MCP!" }),
    )
    .await;
    assert_eq!(commented["comments"].as_array().unwrap().len(), 1);

    let rels = call_tool(
        "list_releases",
        json!({ "project": "MW", "version": "v1.0.0", "include_changelog": true }),
    )
    .await;
    assert!(rels["changelog"].as_str().unwrap().contains("MCP Created Task"));

    let pg = call_tool(
        "create_wiki_page",
        json!({ "project": "MW", "title": "Rust Guide", "content": "Details about MW-1" }),
    )
    .await;
    assert_eq!(pg["title"], "Rust Guide");

    let pg_upd = call_tool(
        "update_wiki_page",
        json!({ "project": "MW", "page": "Rust Guide", "append": "More notes" }),
    )
    .await;
    assert!(pg_upd["content"].as_str().unwrap().contains("More notes"));

    let found = call_tool("search", json!({ "project": "MW", "query": "Rust Guide" })).await;
    assert!(!found.as_array().unwrap().is_empty());

    let qa = call_tool("ask_knowledge_graph", json!({ "project": "MW", "question": "Rust Guide 설명해줘" })).await;
    assert!(qa["answer"].as_str().unwrap().contains("Rust Guide"));

    // 9) Revoke grant -> immediate 401 on /mcp!
    let (_, grants) = app.json_req(Method::GET, "/api/oauth/grants", Some(&web_tok), None).await;
    let grant_id = grants[0]["id"].as_str().unwrap();
    let (st, _) = app
        .json_req(
            Method::DELETE,
            &format!("/api/oauth/grants/{grant_id}"),
            Some(&web_tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);

    let (st, _) = app
        .json_req(
            Method::POST,
            "/mcp",
            Some(&mcp_tok),
            Some(json!({ "jsonrpc": "2.0", "id": 99, "method": "ping" })),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}
