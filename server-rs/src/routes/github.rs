use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use rand::RngCore;
use regex::Regex;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    new_id, utcnow, GitHubIntegration, GitHubIntegrationRead, GitHubIntegrationUpdate, GitHubLink,
    Permission, PipelineStage, Task,
};
use crate::routes::deps::{require_active_task, require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::events::{publish_event, EventBus};
use crate::services::oauth::const_eq;
use crate::services::tasks::record_changes;
use crate::AppState;

type HmacSha256 = Hmac<Sha256>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/github",
            get(get_github_config).put(update_github_config),
        )
        .route(
            "/projects/{project_id}/tasks/{task_id}/github",
            get(list_task_github_links),
        )
        .route("/webhooks/github", post(github_webhook))
}

fn find_config(db: &Database, project_id: &str) -> ApiResult<Option<GitHubIntegration>> {
    Ok(db
        .github_integrations
        .list_by_project(project_id)?
        .into_iter()
        .next())
}

fn gen_hex_secret(n_bytes: usize) -> String {
    let mut b = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn extract_task_numbers(text: &str, project_key: &str) -> Vec<i64> {
    let pat = format!(r"(?i){}-(\d+)", regex::escape(project_key));
    let Ok(re) = Regex::new(&pat) else {
        return vec![];
    };
    let bytes = text.as_bytes();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for caps in re.captures_iter(text) {
        let m = caps.get(0).unwrap();
        let before_ok = m.start() == 0
            || !matches!(
                bytes[m.start() - 1],
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            );
        let after_ok = m.end() == bytes.len()
            || !matches!(bytes[m.end()], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9');
        if before_ok && after_ok {
            if let Ok(n) = caps[1].parse::<i64>() {
                if seen.insert(n) {
                    out.push(n);
                }
            }
        }
    }
    out
}

fn verify_signature(secret: &str, body: &[u8], signature: &str) -> bool {
    if secret.is_empty() || !signature.starts_with("sha256=") {
        return false;
    }
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac");
    mac.update(body);
    let expected = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    const_eq(&expected, signature)
}

async fn get_github_config(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<GitHubIntegrationRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let cfg = find_config(&state.db, &access.project.id)?;
    let webhook_url = format!("{}/api/webhooks/github", state.settings.base_url());
    Ok(Json(GitHubIntegrationRead {
        repo: cfg.as_ref().map(|c| c.repo.clone()).unwrap_or_default(),
        has_secret: cfg.as_ref().is_some_and(|c| !c.webhook_secret.is_empty()),
        auto_transition: cfg.as_ref().map(|c| c.auto_transition).unwrap_or(true),
        webhook_url,
        generated_secret: None,
    }))
}

async fn update_github_config(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<GitHubIntegrationUpdate>,
) -> ApiResult<Json<GitHubIntegrationRead>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Admin)?;
    let repo = body.repo.trim().trim_matches('/').chars().take(200).collect::<String>();
    let cfg_opt = find_config(&state.db, &access.project.id)?;

    let mut generated = None;
    let secret = if body.rotate_secret {
        let s = gen_hex_secret(24);
        generated = Some(s.clone());
        s
    } else if let Some(s) = body.webhook_secret {
        s.trim().to_string()
    } else if let Some(ref c) = cfg_opt {
        c.webhook_secret.clone()
    } else {
        let s = gen_hex_secret(24);
        generated = Some(s.clone());
        s
    };

    let now = utcnow();
    let cfg = match cfg_opt {
        None => {
            let c = GitHubIntegration {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: access.project.id.clone(),
                repo: repo.clone(),
                webhook_secret: secret,
                auto_transition: body.auto_transition,
            };
            state.db.github_integrations.create(&c)?
        }
        Some(mut existing) => {
            existing.repo = repo.clone();
            existing.webhook_secret = secret;
            existing.auto_transition = body.auto_transition;
            existing.updated_at = now;
            state.db.github_integrations.update(&existing)?;
            existing
        }
    };

    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "project.github_updated",
        "project",
        &access.project.id,
        format!(
            "GitHub 연동 설정 변경: {}",
            if repo.is_empty() { "(해제)" } else { &repo }
        ),
        HashMap::new(),
    );

    Ok(Json(GitHubIntegrationRead {
        repo: cfg.repo,
        has_secret: !cfg.webhook_secret.is_empty(),
        auto_transition: cfg.auto_transition,
        webhook_url: format!("{}/api/webhooks/github", state.settings.base_url()),
        generated_secret: generated,
    }))
}

async fn list_task_github_links(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<GitHubLink>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut links: Vec<GitHubLink> = state
        .db
        .github_links
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|l| l.task_id == task.id)
        .collect();
    links.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(Json(links))
}

#[allow(clippy::too_many_arguments)]
fn upsert_link(
    db: &Database,
    bus: &EventBus,
    project_id: &str,
    task_id: &str,
    kind: &str,
    ref_name: &str,
    title: &str,
    url: &str,
    state_str: &str,
    author: &str,
    branch: &str,
) -> ApiResult<()> {
    let existing = db
        .github_links
        .list_by_project(project_id)?
        .into_iter()
        .find(|l| l.task_id == task_id && l.kind == kind && l.ref_name == ref_name);
    let now = utcnow();
    match existing {
        Some(mut l) => {
            l.title = title.chars().take(200).collect();
            l.url = url.to_string();
            l.state = state_str.to_string();
            l.author = author.to_string();
            l.branch = branch.to_string();
            l.updated_at = now;
            db.github_links.update(&l)?;
        }
        None => {
            let l = GitHubLink {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: project_id.to_string(),
                task_id: task_id.to_string(),
                kind: kind.to_string(),
                ref_name: ref_name.to_string(),
                title: title.chars().take(200).collect(),
                url: url.to_string(),
                state: state_str.to_string(),
                author: author.to_string(),
                branch: branch.to_string(),
            };
            db.github_links.create(&l)?;
        }
    }
    publish_event(
        db,
        bus,
        project_id,
        "github.linked",
        json!({ "task_id": task_id, "kind": kind, "ref": ref_name, "state": state_str }),
    );
    Ok(())
}

fn transition_task(db: &Database, bus: &EventBus, task: &Task, next_stage: PipelineStage) -> ApiResult<()> {
    if task.stage == next_stage {
        return Ok(());
    }
    let mut updated = task.clone();
    updated.stage = next_stage;
    updated.updated_at = utcnow();
    db.tasks.update(&updated)?;
    record_changes(db, task, &updated, "github", None);
    publish_event(
        db,
        bus,
        &task.project_id,
        "task.updated",
        json!({ "task_id": task.id, "stage": next_stage.as_str() }),
    );
    Ok(())
}

async fn github_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> ApiResult<Json<Value>> {
    let event = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let sig = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let payload: Value = serde_json::from_slice(&raw)
        .map_err(|_| ApiError::bad_request("Invalid JSON payload"))?;

    let repo_name = payload
        .get("repository")
        .and_then(|r| r.get("full_name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if repo_name.is_empty() {
        return Ok(Json(json!({ "ok": true, "matched": 0 })));
    }

    let configs: Vec<GitHubIntegration> = state
        .db
        .github_integrations
        .list()?
        .into_iter()
        .filter(|g| g.repo.to_lowercase() == repo_name.to_lowercase())
        .collect();
    if configs.is_empty() {
        return Ok(Json(json!({ "ok": true, "matched": 0 })));
    }

    let mut matched_tasks = 0usize;
    for cfg in configs {
        if !verify_signature(&cfg.webhook_secret, &raw, sig) {
            return Err(ApiError::unauthorized("Invalid GitHub webhook signature"));
        }
        let Some(project) = state.db.projects.get(&cfg.project_id)? else {
            continue;
        };
        let by_num: HashMap<i64, Task> = state
            .db
            .tasks
            .list_by_project(&project.id)?
            .into_iter()
            .filter(|t| t.deleted_at.is_none())
            .map(|t| (t.number, t))
            .collect();

        if event == "pull_request" {
            let pr = payload.get("pull_request").and_then(|v| v.as_object());
            let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let pr_num = pr
                .and_then(|p| p.get("number"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let title = pr.and_then(|p| p.get("title")).and_then(|v| v.as_str()).unwrap_or("");
            let body_text = pr.and_then(|p| p.get("body")).and_then(|v| v.as_str()).unwrap_or("");
            let branch = pr
                .and_then(|p| p.get("head"))
                .and_then(|h| h.get("ref"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let url = pr.and_then(|p| p.get("html_url")).and_then(|v| v.as_str()).unwrap_or("");
            let author = pr
                .and_then(|p| p.get("user"))
                .and_then(|u| u.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let merged = pr
                .and_then(|p| p.get("merged"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let pr_state = if merged {
                "merged"
            } else {
                pr.and_then(|p| p.get("state")).and_then(|v| v.as_str()).unwrap_or("open")
            };

            let combined = format!("{branch}\n{title}\n{body_text}");
            for n in extract_task_numbers(&combined, &project.key) {
                let Some(task) = by_num.get(&n) else {
                    continue;
                };
                upsert_link(
                    &state.db,
                    &state.events,
                    &project.id,
                    &task.id,
                    "pr",
                    &format!("#{pr_num}"),
                    title,
                    url,
                    pr_state,
                    author,
                    branch,
                )?;
                if cfg.auto_transition {
                    if action == "closed" && merged {
                        transition_task(&state.db, &state.events, task, PipelineStage::Done)?;
                    } else if matches!(action, "opened" | "reopened" | "ready_for_review")
                        && matches!(
                            task.stage,
                            PipelineStage::Backlog | PipelineStage::Todo | PipelineStage::InProgress
                        )
                    {
                        transition_task(&state.db, &state.events, task, PipelineStage::Review)?;
                    }
                }
                matched_tasks += 1;
            }
        } else if event == "push" {
            let ref_str = payload.get("ref").and_then(|v| v.as_str()).unwrap_or("");
            let branch = ref_str.strip_prefix("refs/heads/").unwrap_or(ref_str);
            let branch_nums = extract_task_numbers(branch, &project.key);
            if let Some(commits) = payload.get("commits").and_then(|v| v.as_array()) {
                for commit in commits {
                    let sha: String = commit
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(7)
                        .collect();
                    let full_msg = commit.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let msg = full_msg.lines().next().unwrap_or("");
                    let url = commit.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let author = commit
                        .get("author")
                        .and_then(|a| {
                            a.get("username")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                                .or_else(|| a.get("name").and_then(|v| v.as_str()))
                        })
                        .unwrap_or("");
                    let mut seen = HashSet::new();
                    let mut nums = Vec::new();
                    for n in branch_nums
                        .iter()
                        .copied()
                        .chain(extract_task_numbers(full_msg, &project.key))
                    {
                        if seen.insert(n) {
                            nums.push(n);
                        }
                    }
                    for n in nums {
                        let Some(task) = by_num.get(&n) else {
                            continue;
                        };
                        upsert_link(
                            &state.db,
                            &state.events,
                            &project.id,
                            &task.id,
                            "commit",
                            &sha,
                            msg,
                            url,
                            "pushed",
                            author,
                            branch,
                        )?;
                        if cfg.auto_transition
                            && matches!(task.stage, PipelineStage::Backlog | PipelineStage::Todo)
                        {
                            transition_task(&state.db, &state.events, task, PipelineStage::InProgress)?;
                        }
                        matched_tasks += 1;
                    }
                }
            }
        }
    }

    Ok(Json(json!({ "ok": true, "matched": matched_tasks })))
}
