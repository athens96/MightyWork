use std::io::Cursor;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;
use zip::ZipArchive;

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

struct TestApp {
    router: axum::Router,
    _dir: TempDir,
}

impl TestApp {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let mut settings = Settings::from_env();
        settings.data_dir = dir.path().to_path_buf();
        settings.jwt_secret = "phase2-secret-0123456789".into();
        settings.google_client_id = "test-cid".into();
        settings.allowed_email_domains = vec![];
        settings.public_url = "https://mightywork.test".into();
        let db = Database::open(&settings.data_dir).unwrap();
        let state = AppState::new(settings, db).with_google_verifier(mock_google_verifier());
        Self {
            router: create_app(state),
            _dir: dir,
        }
    }

    async fn raw_req(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(tok) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {tok}"));
        }
        if let Some(ct) = content_type {
            builder = builder.header(header::CONTENT_TYPE, ct);
        }
        let req = builder.body(Body::from(body)).unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, headers, bytes)
    }

    async fn req(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (ct, bytes) = match body {
            Some(v) => (Some("application/json"), v.to_string().into_bytes()),
            None => (None, vec![]),
        };
        let (status, _, out) = self.raw_req(method, uri, token, ct, bytes).await;
        let json = if out.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&out)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&out).into()))
        };
        (status, json)
    }

    async fn setup(&self) -> (String, String) {
        let (st, auth) = self
            .req(
                Method::POST,
                "/api/auth/google",
                None,
                Some(json!({ "credential": "alice-token" })),
            )
            .await;
        assert_eq!(st, StatusCode::OK);
        let tok = auth["access_token"].as_str().unwrap().to_string();
        let (st, proj) = self
            .req(
                Method::POST,
                "/api/projects",
                Some(&tok),
                Some(json!({ "name": "Knowledge Hub", "key": "KH" })),
            )
            .await;
        assert_eq!(st, StatusCode::CREATED);
        (tok, proj["id"].as_str().unwrap().to_string())
    }
}

#[tokio::test]
async fn sse_search_links_unlinked_mentions_and_graphs() {
    let app = TestApp::new();
    let (tok, pid) = app.setup().await;

    // Create task and wiki pages
    let (_, task) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/tasks"),
            Some(&tok),
            Some(json!({
                "title": "인증 서버 전환",
                "description": "게이트웨이 모듈을 통해 JWT 발급",
                "version": "v1.0.0",
                "tags": ["auth"]
            })),
        )
        .await;
    let tid = task["id"].as_str().unwrap();

    // SSE once=true replays task.created
    let (st, headers, sse_bytes) = app
        .raw_req(
            Method::GET,
            &format!("/api/projects/{pid}/events?since=0&once=true"),
            Some(&tok),
            None,
            vec![],
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(headers
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let sse_text = String::from_utf8_lossy(&sse_bytes);
    assert!(sse_text.contains("event: connected"), "sse: {sse_text}");
    assert!(sse_text.contains("event: task.created"), "sse: {sse_text}");

    let (_, p1) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/pages"),
            Some(&tok),
            Some(json!({
                "title": "게이트웨이",
                "aliases": ["API GW"],
                "content": "KH-1 작업을 처리합니다. GET /api/auth/me 구현.",
                "page_type": "spec"
            })),
        )
        .await;
    let p1_id = p1["id"].as_str().unwrap();

    // SSE replays wiki.created right after creating a wiki page
    let (st, _, wiki_sse) = app
        .raw_req(
            Method::GET,
            &format!("/api/projects/{pid}/events?since=0&once=true"),
            Some(&tok),
            None,
            vec![],
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let wiki_sse_text = String::from_utf8_lossy(&wiki_sse);
    assert!(wiki_sse_text.contains("event: wiki.created"), "sse: {wiki_sse_text}");
    assert!(wiki_sse_text.contains(p1_id), "sse: {wiki_sse_text}");

    let (_, p2) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/pages"),
            Some(&tok),
            Some(json!({
                "title": "아키텍처",
                "content": "이 문서는 [[게이트웨이]]에 의존하며 API GW 설정과 [[없는문서]]도 언급합니다."
            })),
        )
        .await;
    let p2_id = p2["id"].as_str().unwrap();

    // Project search (FTS5 Korean trigram + exact key match)
    let (st, hits) = app
        .req(Method::GET, &format!("/api/projects/{pid}/search?q=KH-1"), Some(&tok), None)
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hits[0]["kind"], "task");
    assert_eq!(hits[0]["score"], 100.0);

    let (st, global) = app
        .req(Method::GET, "/api/search?q=%EA%B2%8C%EC%9D%B4%ED%8A%B8%EC%9B%A8%EC%9D%B4", Some(&tok), None)
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(global.as_array().unwrap().len() >= 2);

    // Page links & task wiki-refs
    let (st, links) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{p2_id}/links"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(links["outgoing"].as_array().unwrap().len(), 2);

    let (st, refs) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/tasks/{tid}/wiki-refs"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(refs[0]["id"], p1_id);

    // Unlinked mentions for p1 ("게이트웨이" in task + "API GW" in p2)
    let (st, mentions) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{p1_id}/unlinked-mentions"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(mentions.as_array().unwrap().len(), 2);

    // Link unlinked mentions
    let (st, linked) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/pages/{p1_id}/unlinked-mentions/link"),
            Some(&tok),
            Some(json!({ "sources": [{ "source_type": "task", "source_id": tid }] })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(linked["linked"], 1);
    assert_eq!(linked["documents"], 1);

    // Local graph & project graph
    let (st, lg) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{p1_id}/graph?depth=2"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(lg["nodes"].as_array().unwrap().len() >= 3);

    // Knowledge Base: Glossary + Extract + Approve + QA
    let (st, term) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/glossary"),
            Some(&tok),
            Some(json!({
                "term": "JWT",
                "definition": "JSON Web Token 기반 인증 토큰",
                "synonyms": ["액세스 토큰"]
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let term_id = term["id"].as_str().unwrap();

    let (st, usages) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/glossary/{term_id}/usages"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(!usages.as_array().unwrap().is_empty());

    let (st, ext) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/knowledge/extract"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(ext["entities_added"].as_u64().unwrap() >= 3);
    assert!(ext["relations_added"].as_u64().unwrap() >= 1);

    // Approve all extracted entities and relations, then query QA
    let (_, ents) = app
        .req(Method::GET, &format!("/api/projects/{pid}/knowledge/entities"), Some(&tok), None)
        .await;
    for e in ents.as_array().unwrap() {
        let eid = e["id"].as_str().unwrap();
        app.req(
            Method::PATCH,
            &format!("/api/projects/{pid}/knowledge/entities/{eid}"),
            Some(&tok),
            Some(json!({ "status": "approved" })),
        )
        .await;
    }
    let (_, rels) = app
        .req(Method::GET, &format!("/api/projects/{pid}/knowledge/relations"), Some(&tok), None)
        .await;
    for r in rels.as_array().unwrap() {
        let rid = r["id"].as_str().unwrap();
        app.req(
            Method::PATCH,
            &format!("/api/projects/{pid}/knowledge/relations/{rid}"),
            Some(&tok),
            Some(json!({ "status": "approved" })),
        )
        .await;
    }

    let (st, qa) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/knowledge/qa"),
            Some(&tok),
            Some(json!({ "question": "액세스 토큰과 게이트웨이는 무엇인가요?" })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(qa["answer"].as_str().unwrap().contains("JWT"));
    assert!(!qa["citations"].as_array().unwrap().is_empty());

    let (st, pg) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/graph?include_knowledge=true"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(pg["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["kind"] == "glossary"));
}

#[tokio::test]
async fn cycles_milestones_releases_triage_views_and_templates() {
    let app = TestApp::new();
    let (tok, pid) = app.setup().await;

    // Cycle + Milestone
    let (st, cyc) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/cycles"),
            Some(&tok),
            Some(json!({
                "name": "Sprint 1",
                "start_date": "2026-01-01",
                "end_date": "2026-01-14",
                "target_points": 10,
                "status": "active"
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let cid = cyc["id"].as_str().unwrap();

    let (st, ms) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/milestones"),
            Some(&tok),
            Some(json!({
                "name": "M1 Launch",
                "target_date": "2026-03-01",
                "status": "active"
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let msid = ms["id"].as_str().unwrap();

    // Two tasks in cycle & milestone & versions
    app.req(
        Method::POST,
        &format!("/api/projects/{pid}/tasks"),
        Some(&tok),
        Some(json!({
            "title": "Done Feature",
            "stage": "done",
            "cycle_id": cid,
            "milestone_id": msid,
            "version": "v1.0.0",
            "estimate": 3
        })),
    )
    .await;
    let (_, todo_task) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/tasks"),
            Some(&tok),
            Some(json!({
                "title": "Fix bug login",
                "stage": "todo",
                "cycle_id": cid,
                "milestone_id": msid,
                "version": "v1.0.0",
                "tags": ["bug"],
                "estimate": 5
            })),
        )
        .await;
    let todo_tid = todo_task["id"].as_str().unwrap();

    // Complete cycle -> rolls over 1 incomplete task to new Cycle 2!
    let (st, comp) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/cycles/{cid}/complete"),
            Some(&tok),
            Some(json!({ "rollover": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(comp["rolled_over_count"], 1);
    assert_eq!(comp["completed"]["status"], "completed");
    assert_eq!(comp["next_cycle"]["total_tasks"], 1);

    // Milestones progress 50%
    let (_, ms_list) = app
        .req(Method::GET, &format!("/api/projects/{pid}/milestones"), Some(&tok), None)
        .await;
    assert_eq!(ms_list[0]["progress_pct"], 50);

    // Releases + Changelog
    let (st, rels) = app
        .req(Method::GET, &format!("/api/projects/{pid}/releases"), Some(&tok), None)
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(rels["releases"][0]["version"], "v1.0.0");
    assert_eq!(rels["releases"][0]["status"], "in_progress");

    let (st, cl) = app
        .req(
            Method::GET,
            &format!("/api/projects/{pid}/releases/v1.0.0/changelog?include_unfinished=true"),
            Some(&tok),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(cl["markdown"].as_str().unwrap().contains("Done Feature"));
    assert!(cl["markdown"].as_str().unwrap().contains("Fix bug login"));

    // Triage + Public Intake
    let (st, intake) = app
        .req(
            Method::PUT,
            &format!("/api/projects/{pid}/intake"),
            Some(&tok),
            Some(json!({ "enabled": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let intake_token = intake["token"].as_str().unwrap();

    let (st, pub_sub) = app
        .req(
            Method::POST,
            &format!("/api/intake/{intake_token}"),
            None,
            Some(json!({
                "title": "External Bug Report",
                "description": "Crash on submit",
                "reporter_name": "Customer"
            })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let triage_id = pub_sub["task_id"].as_str().unwrap();

    let (st, decided) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/triage/{triage_id}/decide"),
            Some(&tok),
            Some(json!({ "action": "duplicate", "duplicate_of_id": todo_tid })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(decided["triage_status"], "declined");

    // Views & Templates
    let (st, view) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/views"),
            Some(&tok),
            Some(json!({ "name": "My Bugs", "layout": "list", "filters": { "tag": "bug" } })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let vid = view["id"].as_str().unwrap();
    let (st, _) = app
        .req(Method::DELETE, &format!("/api/projects/{pid}/views/{vid}"), Some(&tok), None)
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);

    let (st, tpl) = app
        .req(
            Method::POST,
            &format!("/api/projects/{pid}/task-templates"),
            Some(&tok),
            Some(json!({ "name": "Bug Report", "title_prefix": "[BUG] ", "checklist": ["Repro"] })),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let tpl_id = tpl["id"].as_str().unwrap();
    let (st, tpl_u) = app
        .req(
            Method::PATCH,
            &format!("/api/projects/{pid}/task-templates/{tpl_id}"),
            Some(&tok),
            Some(json!({ "priority": "urgent" })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(tpl_u["priority"], "urgent");
}

#[tokio::test]
async fn attachments_and_wiki_export_import() {
    let app = TestApp::new();
    let (tok, pid) = app.setup().await;

    // Upload PNG attachment
    let boundary = "----mwtestboundary";
    let mut mp = Vec::new();
    mp.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"logo.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    mp.extend_from_slice(b"\x89PNG\r\n\x1a\nfakeimg");
    mp.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let (st, _, body) = app
        .raw_req(
            Method::POST,
            &format!("/api/projects/{pid}/attachments"),
            Some(&tok),
            Some(&format!("multipart/form-data; boundary={boundary}")),
            mp,
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let att: Value = serde_json::from_slice(&body).unwrap();
    let att_id = att["id"].as_str().unwrap();

    // Download attachment -> inline image/png
    let (st, headers, bytes) = app
        .raw_req(
            Method::GET,
            &format!("/api/projects/{pid}/attachments/{att_id}"),
            Some(&tok),
            None,
            vec![],
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
    assert!(headers
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("inline;"));
    assert_eq!(bytes, b"\x89PNG\r\n\x1a\nfakeimg");

    // Reject disallowed HTML upload (415)
    let mut mp_html = Vec::new();
    mp_html.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"evil.html\"\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n--{boundary}--\r\n"
        )
        .as_bytes(),
    );
    let (st, _, _) = app
        .raw_req(
            Method::POST,
            &format!("/api/projects/{pid}/attachments"),
            Some(&tok),
            Some(&format!("multipart/form-data; boundary={boundary}")),
            mp_html,
        )
        .await;
    assert_eq!(st, StatusCode::UNSUPPORTED_MEDIA_TYPE);

    // Import Markdown with YAML front matter + local image stripping
    let md_upload = "---\ntitle: \"가져온 문서\"\naliases: [\"별칭1\"]\ntags: [\"docs\"]\ntype: \"guide\"\nstatus: \"published\"\n---\n\n# 무시될 제목\n\n본문 내용 ![](local.png) <script>xss()</script>\n";
    let mut mp_md = Vec::new();
    mp_md.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.md\"\r\nContent-Type: text/markdown\r\n\r\n{md_upload}\r\n--{boundary}--\r\n"
        )
        .as_bytes(),
    );
    let (st, _, imp_bytes) = app
        .raw_req(
            Method::POST,
            &format!("/api/projects/{pid}/wiki/import"),
            Some(&tok),
            Some(&format!("multipart/form-data; boundary={boundary}")),
            mp_md,
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let imp: Value = serde_json::from_slice(&imp_bytes).unwrap();
    assert_eq!(imp["title"], "가져온 문서");
    assert_eq!(imp["aliases"][0], "별칭1");
    assert_eq!(imp["page_type"], "guide");
    assert!(!imp["content"].as_str().unwrap().contains("local.png"));
    let page_id = imp["id"].as_str().unwrap();

    // Export HTML -> raw <script> escaped!
    let (st, _, html_bytes) = app
        .raw_req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{page_id}/export?format=html"),
            Some(&tok),
            None,
            vec![],
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let html_str = String::from_utf8_lossy(&html_bytes);
    assert!(html_str.contains("&lt;script&gt;xss()&lt;/script&gt;"), "html: {html_str}");

    // Export MD -> front matter preserved
    let (st, _, md_bytes) = app
        .raw_req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/pages/{page_id}/export?format=md"),
            Some(&tok),
            None,
            vec![],
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let md_out = String::from_utf8_lossy(&md_bytes);
    assert!(md_out.starts_with("---\ntitle: \"가져온 문서\""));

    // Export ZIP -> contains wiki/*.md and wiki.html
    let (st, _, zip_bytes) = app
        .raw_req(
            Method::GET,
            &format!("/api/projects/{pid}/wiki/export.zip"),
            Some(&tok),
            None,
            vec![],
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let mut z = ZipArchive::new(Cursor::new(zip_bytes)).unwrap();
    let mut names = Vec::new();
    for i in 0..z.len() {
        names.push(z.by_index(i).unwrap().name().to_string());
    }
    assert!(names.iter().any(|n| n == "wiki.html"));
    assert!(names.iter().any(|n| n.ends_with(".md")));
}
