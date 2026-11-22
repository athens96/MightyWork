use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::models::{
    clean_string_list, new_id, utcnow, EntityKind, ExtractResult, GlossaryTerm, GlossaryTermCreate,
    GlossaryTermUpdate, GlossaryUsage, KnowledgeEntity, KnowledgeEntityCreate, KnowledgeEntityUpdate,
    KnowledgeRelation, KnowledgeRelationCreate, KnowledgeRelationUpdate, Permission, QARequest,
    QAResponse,
};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::services::graph::{full_project_graph, ProjectGraph};
use crate::services::knowledge_extract::extract_project_knowledge;
use crate::services::knowledge_qa::answer_question;
use crate::services::links::{find_mentions, mention_snippets, norm_title, project_pages};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/graph", get(get_project_graph))
        .route(
            "/projects/{project_id}/glossary",
            get(list_glossary).post(create_glossary_term),
        )
        .route(
            "/projects/{project_id}/glossary/{term_id}",
            patch(update_glossary_term).delete(delete_glossary_term),
        )
        .route(
            "/projects/{project_id}/glossary/{term_id}/usages",
            get(glossary_usages),
        )
        .route("/projects/{project_id}/knowledge/extract", post(run_extraction))
        .route(
            "/projects/{project_id}/knowledge/entities",
            get(list_entities).post(create_entity),
        )
        .route(
            "/projects/{project_id}/knowledge/entities/{entity_id}",
            patch(update_entity).delete(delete_entity),
        )
        .route(
            "/projects/{project_id}/knowledge/relations",
            get(list_relations).post(create_relation),
        )
        .route(
            "/projects/{project_id}/knowledge/relations/{relation_id}",
            patch(update_relation).delete(delete_relation),
        )
        .route("/projects/{project_id}/knowledge/qa", post(knowledge_qa))
}

#[derive(Debug, Deserialize)]
struct GraphQuery {
    include_knowledge: Option<bool>,
    max_nodes: Option<usize>,
}

async fn get_project_graph(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<GraphQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<ProjectGraph>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let include_knowledge = q.include_knowledge.unwrap_or(true);
    let max_nodes = q.max_nodes.unwrap_or(250).clamp(10, 500);
    Ok(Json(full_project_graph(
        &state.db,
        &access.project,
        include_knowledge,
        max_nodes,
    )?))
}

// ---------------------------------------------------------------- Glossary

fn get_term_or_404(db: &Database, project_id: &str, term_id: &str) -> ApiResult<GlossaryTerm> {
    let term = db
        .glossary_terms
        .get(term_id)?
        .ok_or_else(|| ApiError::not_found("Glossary term not found"))?;
    if term.project_id != project_id {
        return Err(ApiError::not_found("Glossary term not found"));
    }
    Ok(term)
}

fn validate_broader(db: &Database, project_id: &str, term_id: Option<&str>, broader_id: Option<&str>) -> ApiResult<()> {
    let mut current = broader_id.map(str::to_string);
    while let Some(cur) = current {
        if term_id == Some(cur.as_str()) {
            return Err(ApiError::bad_request("Glossary term cannot be broader than itself"));
        }
        let parent = db
            .glossary_terms
            .get(&cur)?
            .ok_or_else(|| ApiError::bad_request("Broader glossary term not found"))?;
        if parent.project_id != project_id {
            return Err(ApiError::bad_request("Broader glossary term not found"));
        }
        current = parent.broader_id;
    }
    Ok(())
}

fn validate_wiki_ref(db: &Database, project_id: &str, wiki_page_id: Option<&str>) -> ApiResult<()> {
    if let Some(wid) = wiki_page_id {
        let p = db
            .wiki_pages
            .get(wid)?
            .ok_or_else(|| ApiError::bad_request("Wiki page not found"))?;
        if p.project_id != project_id {
            return Err(ApiError::bad_request("Wiki page not found"));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct GlossaryQuery {
    q: Option<String>,
}

async fn list_glossary(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<GlossaryQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<GlossaryTerm>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut terms = state.db.glossary_terms.list_by_project(&access.project.id)?;
    if let Some(needle) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let n = needle.to_lowercase();
        terms.retain(|g| {
            g.term.to_lowercase().contains(&n)
                || g.definition.to_lowercase().contains(&n)
                || g.synonyms.iter().any(|s| s.to_lowercase().contains(&n))
        });
    }
    terms.sort_by(|a, b| a.term.to_lowercase().cmp(&b.term.to_lowercase()));
    Ok(Json(terms))
}

async fn create_glossary_term(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<GlossaryTermCreate>,
) -> ApiResult<(StatusCode, Json<GlossaryTerm>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    let term_str = body.term.trim().to_string();
    if term_str.is_empty() || term_str.chars().count() > 120 {
        return Err(ApiError::unprocessable("term must be 1..120 chars"));
    }
    validate_broader(&state.db, &access.project.id, None, body.broader_id.as_deref())?;
    validate_wiki_ref(&state.db, &access.project.id, body.wiki_page_id.as_deref())?;
    if state
        .db
        .glossary_terms
        .list_by_project(&access.project.id)?
        .iter()
        .any(|g| norm_title(&g.term) == norm_title(&term_str))
    {
        return Err(ApiError::conflict(format!("Glossary term '{term_str}' already exists")));
    }
    let now = utcnow();
    let term = GlossaryTerm {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id,
        term: term_str,
        definition: body.definition.chars().take(2000).collect(),
        synonyms: clean_string_list(&body.synonyms),
        broader_id: body.broader_id,
        wiki_page_id: body.wiki_page_id,
        created_by: user.id.clone(),
        updated_by: user.id,
    };
    state.db.glossary_terms.create(&term)?;
    Ok((StatusCode::CREATED, Json(term)))
}

async fn update_glossary_term(
    State(state): State<AppState>,
    Path((project_id, term_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<GlossaryTermUpdate>,
) -> ApiResult<Json<GlossaryTerm>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut term = get_term_or_404(&state.db, &access.project.id, &term_id)?;

    if let Some(ref bid) = body.broader_id {
        validate_broader(&state.db, &access.project.id, Some(&term.id), bid.as_deref())?;
        term.broader_id = bid.clone();
    }
    if let Some(ref wid) = body.wiki_page_id {
        validate_wiki_ref(&state.db, &access.project.id, wid.as_deref())?;
        term.wiki_page_id = wid.clone();
    }
    if let Some(t) = body.term {
        let trimmed = t.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 120 {
            return Err(ApiError::unprocessable("term must be 1..120 chars"));
        }
        if norm_title(&trimmed) != norm_title(&term.term)
            && state
                .db
                .glossary_terms
                .list_by_project(&access.project.id)?
                .iter()
                .any(|g| g.id != term.id && norm_title(&g.term) == norm_title(&trimmed))
        {
            return Err(ApiError::conflict(format!("Glossary term '{trimmed}' already exists")));
        }
        term.term = trimmed;
    }
    if let Some(d) = body.definition {
        term.definition = d.chars().take(2000).collect();
    }
    if let Some(s) = body.synonyms {
        term.synonyms = clean_string_list(&s);
    }
    term.updated_by = user.id;
    term.updated_at = utcnow();
    state.db.glossary_terms.update(&term)?;
    Ok(Json(term))
}

async fn delete_glossary_term(
    State(state): State<AppState>,
    Path((project_id, term_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    get_term_or_404(&state.db, &access.project.id, &term_id)?;
    for mut child in state
        .db
        .glossary_terms
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|g| g.broader_id.as_deref() == Some(&term_id))
    {
        child.broader_id = None;
        state.db.glossary_terms.update(&child)?;
    }
    state.db.glossary_terms.delete(&term_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn glossary_usages(
    State(state): State<AppState>,
    Path((project_id, term_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<GlossaryUsage>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let term = get_term_or_404(&state.db, &access.project.id, &term_id)?;
    let mut names = vec![term.term];
    names.extend(term.synonyms);
    let mut out = Vec::new();
    for p in project_pages(&state.db, &access.project.id)? {
        let spans = find_mentions(&p.content, &names);
        if !spans.is_empty() {
            let snippets = mention_snippets(&p.content, &spans, 40, 2);
            out.push(GlossaryUsage {
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
        let text = format!("{}\n{}", t.title, t.description);
        let spans = find_mentions(&text, &names);
        if !spans.is_empty() {
            let snippets = mention_snippets(&text, &spans, 40, 2);
            out.push(GlossaryUsage {
                source_type: "task",
                source_id: t.id,
                title: t.title,
                number: Some(t.number),
                count: spans.len(),
                snippets,
            });
        }
    }
    out.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(Json(out))
}

// ---------------------------------------------------------------- Entities & Relations

async fn run_extraction(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<ExtractResult>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let result = extract_project_knowledge(&state.db, &access.project)?;
    let mut details = HashMap::new();
    details.insert("entities_added".into(), json!(result.entities_added));
    details.insert("relations_added".into(), json!(result.relations_added));
    details.insert("pending_entities".into(), json!(result.pending_entities));
    details.insert("pending_relations".into(), json!(result.pending_relations));
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "knowledge.extracted",
        "knowledge",
        &access.project.id,
        format!(
            "지식 추출: 엔티티 +{}, 관계 +{}",
            result.entities_added, result.relations_added
        ),
        details,
    );
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
struct EntityListQuery {
    status: Option<String>,
    kind: Option<EntityKind>,
}

async fn list_entities(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<EntityListQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<KnowledgeEntity>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut items: Vec<KnowledgeEntity> = state
        .db
        .knowledge_entities
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|e| {
            q.status.as_deref().is_none_or(|s| e.status == s)
                && q.kind.is_none_or(|k| e.kind == k)
        })
        .collect();
    items.sort_by(|a, b| {
        (a.status != "pending")
            .cmp(&(b.status != "pending"))
            .then_with(|| b.confidence.total_cmp(&a.confidence))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Json(items))
}

fn validate_review_status(s: &str) -> ApiResult<()> {
    if !matches!(s, "pending" | "approved" | "rejected") {
        return Err(ApiError::unprocessable("status must be pending, approved, or rejected"));
    }
    Ok(())
}

async fn create_entity(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<KnowledgeEntityCreate>,
) -> ApiResult<(StatusCode, Json<KnowledgeEntity>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    validate_review_status(&body.status)?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 160 {
        return Err(ApiError::unprocessable("name must be 1..160 chars"));
    }
    if state
        .db
        .knowledge_entities
        .list_by_project(&access.project.id)?
        .iter()
        .any(|e| norm_title(&e.name) == norm_title(&name))
    {
        return Err(ApiError::conflict(format!("Entity '{name}' already exists")));
    }
    let now = utcnow();
    let reviewed = body.status != "pending";
    let ent = KnowledgeEntity {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id,
        name,
        kind: body.kind,
        description: body.description.chars().take(2000).collect(),
        aliases: clean_string_list(&body.aliases),
        status: body.status,
        confidence: 1.0,
        sources: vec![],
        reviewed_by: reviewed.then(|| user.id.clone()),
        reviewed_at: reviewed.then_some(now),
    };
    state.db.knowledge_entities.create(&ent)?;
    Ok((StatusCode::CREATED, Json(ent)))
}

async fn update_entity(
    State(state): State<AppState>,
    Path((project_id, entity_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<KnowledgeEntityUpdate>,
) -> ApiResult<Json<KnowledgeEntity>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut ent = state
        .db
        .knowledge_entities
        .get(&entity_id)?
        .ok_or_else(|| ApiError::not_found("Entity not found"))?;
    if ent.project_id != access.project.id {
        return Err(ApiError::not_found("Entity not found"));
    }
    let now = utcnow();
    let mut reviewed_changed = false;
    if let Some(n) = body.name {
        let trimmed = n.trim().to_string();
        if trimmed.is_empty() || trimmed.chars().count() > 160 {
            return Err(ApiError::unprocessable("name must be 1..160 chars"));
        }
        ent.name = trimmed;
    }
    if let Some(k) = body.kind {
        ent.kind = k;
    }
    if let Some(d) = body.description {
        ent.description = d.chars().take(2000).collect();
    }
    if let Some(a) = body.aliases {
        ent.aliases = clean_string_list(&a);
    }
    if let Some(st) = body.status {
        validate_review_status(&st)?;
        if st != ent.status {
            ent.status = st;
            ent.reviewed_by = Some(user.id.clone());
            ent.reviewed_at = Some(now);
            reviewed_changed = true;
        }
    }
    ent.updated_at = now;
    state.db.knowledge_entities.update(&ent)?;
    if reviewed_changed {
        record_audit(
            &state.db,
            &access.project.id,
            &user.id,
            "knowledge.reviewed",
            "knowledge",
            &ent.id,
            format!("엔티티 '{}' → {}", ent.name, ent.status),
            HashMap::new(),
        );
    }
    Ok(Json(ent))
}

async fn delete_entity(
    State(state): State<AppState>,
    Path((project_id, entity_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let ent = state
        .db
        .knowledge_entities
        .get(&entity_id)?
        .ok_or_else(|| ApiError::not_found("Entity not found"))?;
    if ent.project_id != access.project.id {
        return Err(ApiError::not_found("Entity not found"));
    }
    for rel in state
        .db
        .knowledge_relations
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|r| r.source_entity_id == entity_id || r.target_entity_id == entity_id)
    {
        state.db.knowledge_relations.delete(&rel.id)?;
    }
    state.db.knowledge_entities.delete(&entity_id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct RelationListQuery {
    status: Option<String>,
}

async fn list_relations(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<RelationListQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<KnowledgeRelation>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut items: Vec<KnowledgeRelation> = state
        .db
        .knowledge_relations
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|r| q.status.as_deref().is_none_or(|s| r.status == s))
        .collect();
    items.sort_by(|a, b| {
        (a.status != "pending")
            .cmp(&(b.status != "pending"))
            .then_with(|| b.confidence.total_cmp(&a.confidence))
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    Ok(Json(items))
}

async fn create_relation(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<KnowledgeRelationCreate>,
) -> ApiResult<(StatusCode, Json<KnowledgeRelation>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;
    validate_review_status(&body.status)?;
    if body.source_entity_id == body.target_entity_id {
        return Err(ApiError::bad_request("Cannot relate an entity to itself"));
    }
    let src = state.db.knowledge_entities.get(&body.source_entity_id)?;
    let dst = state.db.knowledge_entities.get(&body.target_entity_id)?;
    if src.as_ref().map(|e| e.project_id.as_str()) != Some(&access.project.id)
        || dst.as_ref().map(|e| e.project_id.as_str()) != Some(&access.project.id)
    {
        return Err(ApiError::not_found("Entity not found"));
    }
    let now = utcnow();
    let reviewed = body.status != "pending";
    let rel = KnowledgeRelation {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id,
        source_entity_id: body.source_entity_id,
        target_entity_id: body.target_entity_id,
        kind: body.kind,
        evidence: body.evidence.chars().take(500).collect(),
        source_ref: None,
        status: body.status,
        confidence: 1.0,
        reviewed_by: reviewed.then(|| user.id.clone()),
        reviewed_at: reviewed.then_some(now),
    };
    state.db.knowledge_relations.create(&rel)?;
    Ok((StatusCode::CREATED, Json(rel)))
}

async fn update_relation(
    State(state): State<AppState>,
    Path((project_id, relation_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
    Json(body): Json<KnowledgeRelationUpdate>,
) -> ApiResult<Json<KnowledgeRelation>> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Edit)?;
    let mut rel = state
        .db
        .knowledge_relations
        .get(&relation_id)?
        .ok_or_else(|| ApiError::not_found("Relation not found"))?;
    if rel.project_id != access.project.id {
        return Err(ApiError::not_found("Relation not found"));
    }
    let now = utcnow();
    let mut reviewed_changed = false;
    if let Some(k) = body.kind {
        rel.kind = k;
    }
    if let Some(e) = body.evidence {
        rel.evidence = e.chars().take(500).collect();
    }
    if let Some(st) = body.status {
        validate_review_status(&st)?;
        if st != rel.status {
            rel.status = st;
            rel.reviewed_by = Some(user.id.clone());
            rel.reviewed_at = Some(now);
            reviewed_changed = true;
        }
    }
    rel.updated_at = now;
    state.db.knowledge_relations.update(&rel)?;
    if reviewed_changed {
        record_audit(
            &state.db,
            &access.project.id,
            &user.id,
            "knowledge.reviewed",
            "knowledge",
            &rel.id,
            format!("관계({}) → {}", rel.kind.as_str(), rel.status),
            HashMap::new(),
        );
    }
    Ok(Json(rel))
}

async fn delete_relation(
    State(state): State<AppState>,
    Path((project_id, relation_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let rel = state
        .db
        .knowledge_relations
        .get(&relation_id)?
        .ok_or_else(|| ApiError::not_found("Relation not found"))?;
    if rel.project_id != access.project.id {
        return Err(ApiError::not_found("Relation not found"));
    }
    state.db.knowledge_relations.delete(&relation_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn knowledge_qa(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    Json(body): Json<QARequest>,
) -> ApiResult<Json<QAResponse>> {
    let access = require_project_access(&state, &project_id, &user)?;
    if body.question.trim().is_empty() || body.question.chars().count() > 500 {
        return Err(ApiError::unprocessable("question must be 1..500 chars"));
    }
    Ok(Json(answer_question(&state.db, &access.project, &body.question)?))
}
