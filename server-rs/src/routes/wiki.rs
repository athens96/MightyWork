use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    clean_string_list, new_id, toggle_reaction_map, utcnow, CommentBody, PageStatus, PageType,
    Permission, Project, ReactionToggle, WikiComment, WikiCommentUpdate, WikiPage, WikiPageCreate,
    WikiPageSummary, WikiPageUpdate, WikiRevisionDetail, WikiRevisionSummary, ALLOWED_REACTIONS,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::access::is_member_user;
use crate::services::audit::record_audit;
use crate::services::events::publish_event;
use crate::services::links::{link_targets, norm_title, pages_by_title, propagate_rename};
use crate::services::notifications::{notify_mentions, notify_user};
use crate::services::tasks::{delete_wiki_page_cascade, soft_delete_wiki_page};
use crate::services::wiki_revisions::{line_diff, list_revisions, record_revision};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/wiki/pages", get(list_pages).post(create_page))
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}",
            get(get_page).patch(update_page).delete(delete_page),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/comments",
            get(list_page_comments).post(create_page_comment),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/comments/{comment_id}",
            patch(update_page_comment).delete(delete_page_comment),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/comments/{comment_id}/reactions",
            post(toggle_page_comment_reaction),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/revisions",
            get(get_page_revisions),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/revisions/{rev_id}",
            get(get_page_revision),
        )
        .route(
            "/projects/{project_id}/wiki/pages/{page_id}/revisions/{rev_id}/restore",
            post(restore_page_revision),
        )
}

pub fn get_active_page(db: &Database, project_id: &str, page_id: &str) -> ApiResult<WikiPage> {
    let page = db
        .wiki_pages
        .get(page_id)?
        .ok_or_else(|| ApiError::not_found("Page not found"))?;
    if page.project_id != project_id || page.deleted_at.is_some() {
        return Err(ApiError::not_found("Page not found"));
    }
    Ok(page)
}

pub fn validate_parent(db: &Database, project_id: &str, page_id: Option<&str>, parent_id: Option<&str>) -> ApiResult<()> {
    let mut current = parent_id.map(str::to_string);
    while let Some(cur) = current {
        if page_id == Some(cur.as_str()) {
            return Err(ApiError::bad_request("Page cannot be nested under itself"));
        }
        let parent = db
            .wiki_pages
            .get(&cur)?
            .ok_or_else(|| ApiError::bad_request("Parent page not found"))?;
        if parent.project_id != project_id || parent.deleted_at.is_some() {
            return Err(ApiError::bad_request("Parent page not found"));
        }
        current = parent.parent_id;
    }
    Ok(())
}

fn ensure_owner_is_member(db: &Database, project: &Project, owner_id: Option<&str>) -> ApiResult<()> {
    if let Some(oid) = owner_id {
        if !is_member_user(db, project, oid)? {
            return Err(ApiError::bad_request("Owner must be a project member"));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ListPagesQuery {
    page_type: Option<PageType>,
    status: Option<PageStatus>,
    tag: Option<String>,
    owner_id: Option<String>,
}

async fn list_pages(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<ListPagesQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<WikiPageSummary>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let all_pages: Vec<WikiPage> = state
        .db
        .wiki_pages
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|p| p.deleted_at.is_none())
        .collect();

    let by_title = pages_by_title(&all_pages);
    let mut backlink_counts: HashMap<String, usize> = HashMap::new();
    let mut broken_counts: HashMap<String, usize> = HashMap::new();
    for p in &all_pages {
        let mut linked_ids: HashSet<String> = HashSet::new();
        let mut broken = 0usize;
        for raw_target in link_targets(&p.content) {
            match by_title.get(&norm_title(&raw_target)) {
                None => broken += 1,
                Some(resolved) if resolved.id != p.id => {
                    linked_ids.insert(resolved.id.clone());
                }
                _ => {}
            }
        }
        if broken > 0 {
            broken_counts.insert(p.id.clone(), broken);
        }
        for tid in linked_ids {
            *backlink_counts.entry(tid).or_insert(0) += 1;
        }
    }

    let tag_key = q.tag.as_deref().map(|t| t.to_lowercase());
    let mut pages: Vec<WikiPage> = all_pages
        .into_iter()
        .filter(|p| {
            (q.page_type.is_none() || p.page_type == q.page_type)
                && (q.status.is_none() || p.status == q.status)
                && (tag_key.is_none()
                    || p.tags.iter().any(|t| t.to_lowercase() == tag_key.as_deref().unwrap()))
                && (q.owner_id.is_none() || p.owner_id == q.owner_id)
        })
        .collect();
    pages.sort_by_key(|p| p.created_at);

    Ok(Json(
        pages
            .iter()
            .map(|p| {
                WikiPageSummary::from_page(
                    p,
                    *backlink_counts.get(&p.id).unwrap_or(&0),
                    *broken_counts.get(&p.id).unwrap_or(&0),
                )
            })
            .collect(),
    ))
}

async fn create_page(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<WikiPageCreate>,
) -> ApiResult<(StatusCode, Json<WikiPage>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    if body.title.is_empty() || body.title.chars().count() > 200 {
        return Err(ApiError::unprocessable("title must be 1..200 chars"));
    }
    validate_parent(&state.db, &access.project.id, None, body.parent_id.as_deref())?;
    ensure_owner_is_member(&state.db, &access.project, body.owner_id.as_deref())?;

    let now = utcnow();
    let page = WikiPage {
        id: new_id(),
        created_at: now,
        updated_at: now,
        title: body.title,
        content: body.content,
        parent_id: body.parent_id,
        aliases: clean_string_list(&body.aliases),
        page_type: body.page_type,
        status: body.status,
        owner_id: body.owner_id,
        tags: clean_string_list(&body.tags),
        project_id: access.project.id.clone(),
        created_by: user.id.clone(),
        updated_by: user.id.clone(),
        deleted_at: None,
        deleted_by: None,
    };
    state.db.wiki_pages.create(&page)?;
    record_revision(&state.db, &page, &user.id, "초기 작성", None)?;
    notify_mentions(
        &state.db,
        &state.events,
        &access.project,
        &user,
        &page.content,
        &format!("위키 '{}' 에서 나를 언급했습니다", page.title),
        &format!("/projects/{}/wiki/{}", access.project.id, page.id),
    );
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "wiki.created",
        "wiki",
        &page.id,
        format!("위키 '{}' 생성", page.title),
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.created",
        json!({ "page_id": page.id }),
    );
    Ok((StatusCode::CREATED, Json(page)))
}

async fn get_page(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<WikiPage>> {
    let access = require_project_access(&state, &project_id, &user)?;
    Ok(Json(get_active_page(&state.db, &access.project.id, &page_id)?))
}

async fn update_page(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<WikiPageUpdate>,
) -> ApiResult<Json<WikiPage>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;

    if let Some(expected) = body.expected_updated_at {
        let diff_us = (page.updated_at - expected).num_microseconds().unwrap_or(i64::MAX).abs();
        if diff_us > 1 {
            return Err(ApiError::conflict(
                "다른 사용자가 이미 이 문서를 수정했습니다. 최신 내용을 확인한 뒤 다시 저장하세요.",
            ));
        }
    }

    let mut updated = page.clone();
    if let Some(title_opt) = body.title {
        let Some(title) = title_opt else {
            return Err(ApiError::unprocessable("title cannot be null"));
        };
        if title.is_empty() || title.chars().count() > 200 {
            return Err(ApiError::unprocessable("title must be 1..200 chars"));
        }
        updated.title = title;
    }
    if let Some(Some(content)) = body.content {
        updated.content = content;
    }
    if let Some(parent_opt) = body.parent_id {
        validate_parent(&state.db, &access.project.id, Some(&page.id), parent_opt.as_deref())?;
        updated.parent_id = parent_opt;
    }
    if let Some(Some(aliases)) = body.aliases {
        updated.aliases = clean_string_list(&aliases);
    }
    if let Some(pt) = body.page_type {
        updated.page_type = pt;
    }
    if let Some(st) = body.status {
        updated.status = st;
    }
    if let Some(owner_opt) = body.owner_id {
        ensure_owner_is_member(&state.db, &access.project, owner_opt.as_deref())?;
        updated.owner_id = owner_opt;
    }
    if let Some(Some(tags)) = body.tags {
        updated.tags = clean_string_list(&tags);
    }

    updated.updated_by = user.id.clone();
    updated.updated_at = utcnow();
    state.db.wiki_pages.update(&updated)?;

    if updated.title != page.title
        || updated.content != page.content
        || updated.aliases != page.aliases
        || updated.page_type != page.page_type
        || updated.status != page.status
        || updated.tags != page.tags
    {
        record_revision(&state.db, &updated, &user.id, "", None)?;
    }
    if updated.content != page.content {
        notify_mentions(
            &state.db,
            &state.events,
            &access.project,
            &user,
            &updated.content,
            &format!("위키 '{}' 에서 나를 언급했습니다", updated.title),
            &format!("/projects/{}/wiki/{}", access.project.id, updated.id),
        );
    }
    propagate_rename(&state.db, &access.project, &updated, &page.title)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.updated",
        json!({ "page_id": updated.id }),
    );
    Ok(Json(updated))
}

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    permanent: bool,
}

async fn delete_page(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    Query(q): Query<DeleteQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let has_active_children = state
        .db
        .wiki_pages
        .list_by_project(&access.project.id)?
        .into_iter()
        .any(|p| p.parent_id.as_deref() == Some(&page.id) && p.deleted_at.is_none());
    if has_active_children {
        return Err(ApiError::conflict("Delete or move child pages first"));
    }
    let summary = if q.permanent {
        delete_wiki_page_cascade(&state.db, &access.project.id, &page.id)?;
        format!("위키 '{}' 영구 삭제", page.title)
    } else {
        soft_delete_wiki_page(&state.db, &page, &user.id)?;
        format!("위키 '{}' 휴지통 이동", page.title)
    };
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        if q.permanent { "wiki.deleted" } else { "wiki.trashed" },
        "wiki",
        &page.id,
        summary,
        HashMap::new(),
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.deleted",
        json!({ "page_id": page.id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- Wiki Comments

async fn list_page_comments(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<WikiComment>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let mut items: Vec<WikiComment> = state
        .db
        .wiki_comments
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|c| c.page_id == page.id)
        .collect();
    items.sort_by_key(|c| c.created_at);
    Ok(Json(items))
}

async fn create_page_comment(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<CommentBody>,
) -> ApiResult<(StatusCode, Json<WikiComment>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    if body.body.is_empty() || body.body.chars().count() > 20_000 {
        return Err(ApiError::unprocessable("body must be 1..20000 chars"));
    }

    let now = utcnow();
    let comment = WikiComment {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        page_id: page.id.clone(),
        author_id: user.id.clone(),
        body: body.body,
        resolved: false,
        resolved_by: None,
        reactions: HashMap::new(),
        via_client: None,
    };
    state.db.wiki_comments.create(&comment)?;

    let link = format!("/projects/{}/wiki/{}", access.project.id, page.id);
    let mentioned = notify_mentions(
        &state.db,
        &state.events,
        &access.project,
        &user,
        &comment.body,
        &format!("위키 '{}' 댓글에서 나를 언급했습니다", page.title),
        &link,
    );
    let already: HashSet<String> = mentioned.into_iter().map(|n| n.user_id).collect();
    let excerpt: String = comment
        .body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(140)
        .collect();
    let mut recipients = HashSet::new();
    if let Some(o) = &page.owner_id {
        recipients.insert(o.clone());
    }
    recipients.insert(page.created_by.clone());
    for uid in recipients {
        if !already.contains(&uid) {
            notify_user(
                &state.db,
                &state.events,
                &uid,
                &access.project.id,
                &user.id,
                "comment",
                &format!("위키 '{}' 에 새 댓글이 달렸습니다", page.title),
                &excerpt,
                &link,
            );
        }
    }
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.comment_created",
        json!({ "page_id": page.id, "comment_id": comment.id }),
    );
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn update_page_comment(
    State(state): State<AppState>,
    Path((project_id, page_id, comment_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<WikiCommentUpdate>,
) -> ApiResult<Json<WikiComment>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let mut comment = state
        .db
        .wiki_comments
        .get(&comment_id)?
        .ok_or_else(|| ApiError::not_found("Comment not found"))?;
    if comment.page_id != page.id || comment.project_id != access.project.id {
        return Err(ApiError::not_found("Comment not found"));
    }
    if let Some(new_body) = body.body {
        if comment.author_id != user.id {
            return Err(ApiError::forbidden("Only the author can edit this comment"));
        }
        if new_body.is_empty() || new_body.chars().count() > 20_000 {
            return Err(ApiError::unprocessable("body must be 1..20000 chars"));
        }
        comment.body = new_body;
    }
    if let Some(resolved) = body.resolved {
        if comment.author_id != user.id && !access.can(Permission::Edit) {
            return Err(ApiError::forbidden("Edit permission required to resolve comment"));
        }
        comment.resolved = resolved;
        comment.resolved_by = if resolved { Some(user.id.clone()) } else { None };
    }
    comment.updated_at = utcnow();
    state.db.wiki_comments.update(&comment)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.comment_updated",
        json!({ "page_id": page.id, "comment_id": comment.id }),
    );
    Ok(Json(comment))
}

async fn delete_page_comment(
    State(state): State<AppState>,
    Path((project_id, page_id, comment_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let comment = state
        .db
        .wiki_comments
        .get(&comment_id)?
        .ok_or_else(|| ApiError::not_found("Comment not found"))?;
    if comment.page_id != page.id || comment.project_id != access.project.id {
        return Err(ApiError::not_found("Comment not found"));
    }
    if comment.author_id != user.id && !access.can(Permission::Admin) {
        return Err(ApiError::forbidden("Only the author or admin can delete this comment"));
    }
    state.db.wiki_comments.delete(&comment.id)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.comment_deleted",
        json!({ "page_id": page.id, "comment_id": comment.id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn toggle_page_comment_reaction(
    State(state): State<AppState>,
    Path((project_id, page_id, comment_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<ReactionToggle>,
) -> ApiResult<Json<WikiComment>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    if !ALLOWED_REACTIONS.contains(&body.emoji.as_str()) {
        return Err(ApiError::bad_request("Unsupported reaction emoji"));
    }
    let mut comment = state
        .db
        .wiki_comments
        .get(&comment_id)?
        .ok_or_else(|| ApiError::not_found("Comment not found"))?;
    if comment.page_id != page.id || comment.project_id != access.project.id {
        return Err(ApiError::not_found("Comment not found"));
    }
    comment.reactions = toggle_reaction_map(&comment.reactions, &body.emoji, &user.id);
    state.db.wiki_comments.update(&comment)?;
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.comment_updated",
        json!({ "page_id": page.id, "comment_id": comment.id }),
    );
    Ok(Json(comment))
}

// ---------------------------------------------------------------- Wiki Revisions

async fn get_page_revisions(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<WikiRevisionSummary>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let revs = list_revisions(&state.db, &access.project.id, &page.id)?;
    Ok(Json(
        revs.into_iter()
            .map(|r| WikiRevisionSummary {
                id: r.id,
                page_id: r.page_id,
                version: r.version,
                title: r.title,
                editor_id: r.editor_id,
                note: r.note,
                via_client: r.via_client,
                created_at: r.created_at,
            })
            .collect(),
    ))
}

async fn get_page_revision(
    State(state): State<AppState>,
    Path((project_id, page_id, rev_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<WikiRevisionDetail>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let rev = state
        .db
        .wiki_revisions
        .get(&rev_id)?
        .ok_or_else(|| ApiError::not_found("Revision not found"))?;
    if rev.page_id != page.id || rev.project_id != access.project.id {
        return Err(ApiError::not_found("Revision not found"));
    }
    let diff = line_diff(&rev.content, &page.content);
    Ok(Json(WikiRevisionDetail {
        rev,
        diff_to_current: diff,
    }))
}

async fn restore_page_revision(
    State(state): State<AppState>,
    Path((project_id, page_id, rev_id)): Path<(String, String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<WikiPage>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let page = get_active_page(&state.db, &access.project.id, &page_id)?;
    let rev = state
        .db
        .wiki_revisions
        .get(&rev_id)?
        .ok_or_else(|| ApiError::not_found("Revision not found"))?;
    if rev.page_id != page.id || rev.project_id != access.project.id {
        return Err(ApiError::not_found("Revision not found"));
    }

    let mut restored = page.clone();
    restored.title = rev.title.clone();
    restored.content = rev.content.clone();
    restored.aliases = rev.aliases.clone();
    restored.page_type = rev.page_type;
    restored.status = rev.status;
    restored.tags = rev.tags.clone();
    restored.updated_by = user.id.clone();
    restored.updated_at = utcnow();
    state.db.wiki_pages.update(&restored)?;
    record_revision(&state.db, &restored, &user.id, &format!("v{} 복원", rev.version), None)?;
    propagate_rename(&state.db, &access.project, &restored, &page.title)?;

    let mut details = HashMap::new();
    details.insert("revision_id".into(), json!(rev.id));
    details.insert("version".into(), json!(rev.version));
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "wiki.restored",
        "wiki",
        &page.id,
        format!("위키 '{}' v{} 으로 복원", restored.title, rev.version),
        details,
    );
    publish_event(
        &state.db,
        &state.events,
        &access.project.id,
        "wiki.updated",
        json!({ "page_id": restored.id }),
    );
    Ok(Json(restored))
}
