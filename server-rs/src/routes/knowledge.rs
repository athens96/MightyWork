use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::models::{utcnow, Permission, PipelineStage, WikiPage, WikiPageSummary};
use crate::routes::deps::{require_active_task, require_perm, require_project_access, AuthUser};
use crate::services::access::accessible_projects;
use crate::services::graph::{local_graph, LocalGraph};
use crate::services::links::{
    backlinks, find_mentions, link_mentions, link_targets, mention_snippets, norm_title, page_names,
    pages_by_title, pages_mentioning_task, project_pages, task_numbers,
};
use crate::services::search::{search_global, search_project, GlobalSearchHit, SearchHit};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(global_search))
        .route("/projects/{project_id}/search", get(project_search))
        .route("/projects/{project_id}/wiki/pages/{page_id}/links", get(page_links))
        .route("/projects/{project_id}/tasks/{task_id}/wiki-refs", get(task_wiki_refs))
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/unlinked-mentions",
            get(unlinked_mentions),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/unlinked-mentions/link",
            post(link_unlinked_mentions),
        )
        .route("/projects/{project_id}/wiki/pages/{page_id}/graph", get(page_graph))
}

#[derive(Debug, Deserialize)]
struct GlobalSearchQuery {
    q: String,
    limit: Option<usize>,
    prefer_project_id: Option<String>,
}

async fn global_search(
    State(state): State<AppState>,
    Query(q): Query<GlobalSearchQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<GlobalSearchHit>>> {
    if q.q.trim().is_empty() || q.q.chars().count() > 200 {
        return Err(ApiError::unprocessable("q must be 1..200 chars"));
    }
    let limit = q.limit.unwrap_or(20).clamp(1, 50);
    let projects: Vec<_> = accessible_projects(&state.db, &user)?
        .into_iter()
        .map(|a| a.project)
        .collect();
    Ok(Json(search_global(
        &state.db,
        &projects,
        &q.q,
        limit,
        q.prefer_project_id.as_deref(),
    )?))
}

#[derive(Debug, Deserialize)]
struct ProjectSearchQuery {
    q: String,
    limit: Option<usize>,
}

async fn project_search(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<ProjectSearchQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<SearchHit>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    if q.q.trim().is_empty() || q.q.chars().count() > 200 {
        return Err(ApiError::unprocessable("q must be 1..200 chars"));
    }
    let limit = q.limit.unwrap_or(30).clamp(1, 100);
    Ok(Json(search_project(&state.db, &access.project, &q.q, limit)?))
}

fn active_page_or_404(state: &AppState, project_id: &str, page_id: &str) -> ApiResult<WikiPage> {
    let page = state
        .db
        .wiki_pages
        .get(page_id)?
        .ok_or_else(|| ApiError::not_found("Page not found"))?;
    if page.project_id != project_id || page.deleted_at.is_some() {
        return Err(ApiError::not_found("Page not found"));
    }
    Ok(page)
}

#[derive(Debug, Serialize)]
struct OutgoingLink {
    title: String,
    page_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct TaskRef {
    id: String,
    number: i64,
    title: String,
    stage: PipelineStage,
}

#[derive(Debug, Serialize)]
struct PageLinks {
    outgoing: Vec<OutgoingLink>,
    backlinks: Vec<WikiPageSummary>,
    tasks: Vec<TaskRef>,
    missing_tasks: Vec<i64>,
}

async fn page_links(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<PageLinks>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = active_page_or_404(&state, &access.project.id, &page_id)?;
    let pages = project_pages(&state.db, &access.project.id)?;
    let by_title = pages_by_title(&pages);

    let outgoing = link_targets(&page.content)
        .into_iter()
        .map(|t| {
            let pid = by_title.get(&norm_title(&t)).map(|p| p.id.clone());
            OutgoingLink { title: t, page_id: pid }
        })
        .collect();

    let mut bl = backlinks(&pages, &page.id);
    bl.sort_by(|a, b| a.title.cmp(&b.title));
    let bl_summaries = bl
        .into_iter()
        .map(|p| WikiPageSummary::from_page(&p, 0, 0))
        .collect();

    let tasks_by_num: HashMap<i64, _> = state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .map(|t| (t.number, t))
        .collect();

    let numbers = task_numbers(&page.content, &access.project.key);
    let mut tasks = Vec::new();
    let mut missing_tasks = Vec::new();
    for n in numbers {
        if let Some(t) = tasks_by_num.get(&n) {
            tasks.push(TaskRef {
                id: t.id.clone(),
                number: t.number,
                title: t.title.clone(),
                stage: t.stage,
            });
        } else {
            missing_tasks.push(n);
        }
    }

    Ok(Json(PageLinks {
        outgoing,
        backlinks: bl_summaries,
        tasks,
        missing_tasks,
    }))
}

async fn task_wiki_refs(
    State(state): State<AppState>,
    Path((project_id, task_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<WikiPageSummary>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let task = require_active_task(&state, &access.project.id, &task_id)?;
    let mut pages = pages_mentioning_task(&state.db, &access.project, &task)?;
    pages.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(Json(
        pages
            .into_iter()
            .map(|p| WikiPageSummary::from_page(&p, 0, 0))
            .collect(),
    ))
}

#[derive(Debug, Serialize)]
struct UnlinkedMention {
    source_type: &'static str,
    source_id: String,
    title: String,
    number: Option<i64>,
    count: usize,
    snippets: Vec<String>,
}

async fn unlinked_mentions(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<UnlinkedMention>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = active_page_or_404(&state, &access.project.id, &page_id)?;
    let names = page_names(&page);
    let mut result = Vec::new();

    for p in project_pages(&state.db, &access.project.id)? {
        if p.id == page.id {
            continue;
        }
        let spans = find_mentions(&p.content, &names);
        if !spans.is_empty() {
            let snippets = mention_snippets(&p.content, &spans, 40, 2);
            result.push(UnlinkedMention {
                source_type: "wiki",
                source_id: p.id,
                title: p.title,
                number: None,
                count: spans.len(),
                snippets,
            });
        }
    }
    for t in state
        .db
        .tasks
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
    {
        let spans = find_mentions(&t.description, &names);
        if !spans.is_empty() {
            let snippets = mention_snippets(&t.description, &spans, 40, 2);
            result.push(UnlinkedMention {
                source_type: "task",
                source_id: t.id,
                title: t.title,
                number: Some(t.number),
                count: spans.len(),
                snippets,
            });
        }
    }
    result.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
struct UnlinkedMentionRef {
    source_type: String,
    source_id: String,
}

#[derive(Debug, Deserialize)]
struct LinkMentionsRequest {
    sources: Vec<UnlinkedMentionRef>,
}

#[derive(Debug, Serialize)]
struct LinkMentionsResult {
    linked: usize,
    documents: usize,
}

async fn link_unlinked_mentions(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<LinkMentionsRequest>,
) -> ApiResult<Json<LinkMentionsResult>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let page = active_page_or_404(&state, &access.project.id, &page_id)?;
    let names = page_names(&page);
    let mut linked = 0usize;
    let mut documents = 0usize;

    for r in body.sources {
        let n = if r.source_type == "wiki" {
            let Some(mut doc) = state.db.wiki_pages.get(&r.source_id)? else {
                continue;
            };
            if doc.project_id != access.project.id || doc.id == page.id || doc.deleted_at.is_some() {
                continue;
            }
            let count = find_mentions(&doc.content, &names).len();
            if count > 0 {
                doc.content = link_mentions(&doc.content, &page);
                doc.updated_by = user.id.clone();
                doc.updated_at = utcnow();
                state.db.wiki_pages.update(&doc)?;
                crate::services::events::publish_event(
                    &state.db,
                    &state.events,
                    &access.project.id,
                    "wiki.updated",
                    serde_json::json!({ "page_id": doc.id }),
                );
            }
            count
        } else {
            let Some(mut doc) = state.db.tasks.get(&r.source_id)? else {
                continue;
            };
            if doc.project_id != access.project.id || doc.deleted_at.is_some() {
                continue;
            }
            let count = find_mentions(&doc.description, &names).len();
            if count > 0 {
                doc.description = link_mentions(&doc.description, &page);
                doc.updated_at = utcnow();
                state.db.tasks.update(&doc)?;
            }
            count
        };
        linked += n;
        if n > 0 {
            documents += 1;
        }
    }

    Ok(Json(LinkMentionsResult { linked, documents }))
}

#[derive(Debug, Deserialize)]
struct PageGraphQuery {
    depth: Option<i32>,
}

async fn page_graph(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    Query(q): Query<PageGraphQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<LocalGraph>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = active_page_or_404(&state, &access.project.id, &page_id)?;
    let depth = q.depth.unwrap_or(1).clamp(1, 2);
    Ok(Json(local_graph(
        &state.db,
        &access.project,
        &format!("wiki:{}", page.id),
        depth,
        60,
    )?))
}
