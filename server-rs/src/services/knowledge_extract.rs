use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{
    new_id, utcnow, EntityKind, ExtractResult, KnowledgeEntity, KnowledgeRelation, PageType, Project,
    RelationKind, SourceRef,
};
use crate::services::links::{link_targets, norm_title, project_pages};

fn api_endpoint_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_./{}:-]+)").unwrap())
}

fn md_strip_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[#>*`]+").unwrap())
}

const KIND_CUES: &[(EntityKind, &[&str])] = &[
    (EntityKind::Api, &["api", "엔드포인트", "endpoint", "webhook", "rest", "graphql", "mcp"]),
    (EntityKind::Decision, &["결정", "adr", "의사결정", "선택", "decision", "합의"]),
    (EntityKind::Data, &["db", "데이터", "테이블", "스키마", "모델", "저장소", "sqlite", "postgres", "redis", "json"]),
    (EntityKind::Role, &["역할", "권한", "소유자", "관리자", "담당자", "팀", "role", "admin", "rbac"]),
    (EntityKind::Service, &["서비스", "모듈", "엔진", "서버", "워커", "게이트웨이", "service", "server", "auth", "oauth"]),
    (EntityKind::System, &["시스템", "플랫폼", "아키텍처", "인프라", "파이프라인", "system", "platform"]),
];

const RELATION_CUES: &[(RelationKind, &[&str])] = &[
    (RelationKind::DependsOn, &["의존", "기반", "필요", "전제", "depends on", "requires", "backed by"]),
    (RelationKind::Implements, &["구현", "제공", "처리", "수행", "implements", "provides"]),
    (RelationKind::Produces, &["생성", "발급", "출력", "기록", "저장", "만든", "produces", "creates", "generates"]),
    (RelationKind::Owns, &["담당", "소유", "관리", "운영", "owns", "manages"]),
    (RelationKind::Decides, &["결정", "채택", "선정", "확정", "decides", "chosen"]),
    (RelationKind::Uses, &["사용", "호출", "연동", "활용", "연결", "통해", "uses", "calls", "integrates"]),
];

pub fn infer_entity_kind(name: &str, text: &str, page_type: Option<PageType>) -> EntityKind {
    if page_type == Some(PageType::Decision) {
        return EntityKind::Decision;
    }
    let title_cf = name.to_lowercase();
    for &(kind, cues) in KIND_CUES {
        if cues.iter().any(|c| title_cf.contains(c)) {
            return kind;
        }
    }
    if page_type == Some(PageType::Spec) {
        return EntityKind::Service;
    }
    let sample: String = text.chars().take(400).collect::<String>().to_lowercase();
    for &(kind, cues) in KIND_CUES {
        if cues.iter().any(|c| sample.contains(c)) {
            return kind;
        }
    }
    EntityKind::Concept
}

pub fn infer_relation_kind(sentence: &str) -> RelationKind {
    let s = sentence.to_lowercase();
    for &(kind, cues) in RELATION_CUES {
        if cues.iter().any(|c| s.contains(c)) {
            return kind;
        }
    }
    RelationKind::RelatesTo
}

fn first_excerpt(text: &str, limit: usize) -> String {
    md_strip_re()
        .replace_all(text, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        if ch == '\n' {
            if !cur.trim().is_empty() {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
            continue;
        }
        cur.push(ch);
        if matches!(ch, '.' | '!' | '?' | '。') {
            if !cur.trim().is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

pub fn extract_project_knowledge(db: &Database, project: &Project) -> ApiResult<ExtractResult> {
    let existing_entities = db.knowledge_entities.list_by_project(&project.id)?;
    let mut by_name: HashMap<String, KnowledgeEntity> = HashMap::new();
    for e in existing_entities {
        by_name.insert(norm_title(&e.name), e.clone());
        for a in &e.aliases {
            by_name.entry(norm_title(a)).or_insert_with(|| e.clone());
        }
    }

    let mut entities_added = 0usize;
    let mut ensure_entity = |name: &str,
                             kind: EntityKind,
                             description: String,
                             aliases: Vec<String>,
                             source: SourceRef,
                             confidence: f64|
     -> ApiResult<KnowledgeEntity> {
        let key = norm_title(name);
        if let Some(existing) = by_name.get(&key) {
            return Ok(existing.clone());
        }
        let now = utcnow();
        let ent = KnowledgeEntity {
            id: new_id(),
            created_at: now,
            updated_at: now,
            project_id: project.id.clone(),
            name: name.trim().chars().take(160).collect(),
            kind,
            description: description.chars().take(2000).collect(),
            aliases: aliases.into_iter().take(20).collect(),
            status: "pending".into(),
            confidence,
            sources: vec![source],
            reviewed_by: None,
            reviewed_at: None,
        };
        db.knowledge_entities.create(&ent)?;
        by_name.insert(key, ent.clone());
        for a in &ent.aliases {
            by_name.entry(norm_title(a)).or_insert_with(|| ent.clone());
        }
        entities_added += 1;
        Ok(ent)
    };

    // 1) Glossary -> Entity candidates
    for term in db.glossary_terms.list_by_project(&project.id)? {
        let kind = infer_entity_kind(&term.term, &term.definition, None);
        let excerpt: String = term.definition.chars().take(160).collect();
        ensure_entity(
            &term.term,
            kind,
            term.definition.clone(),
            term.synonyms.clone(),
            SourceRef {
                source_type: "glossary".into(),
                source_id: term.id,
                title: term.term.clone(),
                excerpt,
            },
            0.9,
        )?;
    }

    // 2) Wiki pages -> Entity candidates + API endpoints
    let pages = project_pages(db, &project.id)?;
    let mut page_entity: HashMap<String, KnowledgeEntity> = HashMap::new();
    for p in &pages {
        let kind = infer_entity_kind(&p.title, &p.content, p.page_type);
        let conf = match p.page_type {
            Some(PageType::Spec | PageType::Decision | PageType::Guide) => 0.85,
            _ => 0.72,
        };
        let ent = ensure_entity(
            &p.title,
            kind,
            first_excerpt(&p.content, 300),
            p.aliases.clone(),
            SourceRef {
                source_type: "wiki".into(),
                source_id: p.id.clone(),
                title: p.title.clone(),
                excerpt: first_excerpt(&p.content, 160),
            },
            conf,
        )?;
        page_entity.insert(p.id.clone(), ent);

        for caps in api_endpoint_re().captures_iter(&p.content) {
            let ep_name = format!("{} {}", &caps[1], &caps[2]);
            ensure_entity(
                &ep_name,
                EntityKind::Api,
                format!("'{}' 문서에서 추출된 API 엔드포인트", p.title),
                vec![],
                SourceRef {
                    source_type: "wiki".into(),
                    source_id: p.id.clone(),
                    title: p.title.clone(),
                    excerpt: caps[0].to_string(),
                },
                0.8,
            )?;
        }
    }

    // 3) Relations
    let mut existing_rels: HashSet<(String, String, RelationKind)> = db
        .knowledge_relations
        .list_by_project(&project.id)?
        .into_iter()
        .map(|r| (r.source_entity_id, r.target_entity_id, r.kind))
        .collect();
    let mut relations_added = 0usize;

    let mut add_relation = |src: &KnowledgeEntity,
                            dst: &KnowledgeEntity,
                            kind: RelationKind,
                            evidence: String,
                            source_ref: SourceRef,
                            confidence: f64|
     -> ApiResult<()> {
        if src.id == dst.id || src.status == "rejected" || dst.status == "rejected" {
            return Ok(());
        }
        let key = (src.id.clone(), dst.id.clone(), kind);
        if existing_rels.contains(&key) {
            return Ok(());
        }
        let now = utcnow();
        let rel = KnowledgeRelation {
            id: new_id(),
            created_at: now,
            updated_at: now,
            project_id: project.id.clone(),
            source_entity_id: src.id.clone(),
            target_entity_id: dst.id.clone(),
            kind,
            evidence: evidence.chars().take(500).collect(),
            source_ref: Some(source_ref),
            status: "pending".into(),
            confidence,
            reviewed_by: None,
            reviewed_at: None,
        };
        db.knowledge_relations.create(&rel)?;
        existing_rels.insert(key);
        relations_added += 1;
        Ok(())
    };

    for p in &pages {
        let Some(src_ent) = page_entity.get(&p.id) else {
            continue;
        };
        let sref = SourceRef {
            source_type: "wiki".into(),
            source_id: p.id.clone(),
            title: p.title.clone(),
            excerpt: first_excerpt(&p.content, 160),
        };
        let mut linked_targets: HashMap<String, (RelationKind, String)> = HashMap::new();
        for sent in split_sentences(&p.content) {
            let targets = link_targets(&sent);
            if targets.is_empty() {
                continue;
            }
            let rkind = infer_relation_kind(&sent);
            let snippet: String = sent
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(240)
                .collect();
            for t in targets {
                let tkey = norm_title(&t);
                let replace = match linked_targets.get(&tkey) {
                    None => true,
                    Some((prev, _)) => *prev == RelationKind::RelatesTo,
                };
                if replace {
                    linked_targets.insert(tkey, (rkind, snippet.clone()));
                }
            }
        }
        for (tkey, (rkind, snippet)) in linked_targets {
            if let Some(dst_ent) = by_name.get(&tkey) {
                let conf = if rkind != RelationKind::RelatesTo { 0.8 } else { 0.65 };
                add_relation(src_ent, dst_ent, rkind, snippet, sref.clone(), conf)?;
            }
        }
        for caps in api_endpoint_re().captures_iter(&p.content) {
            let ep_key = norm_title(&format!("{} {}", &caps[1], &caps[2]));
            if let Some(ep_ent) = by_name.get(&ep_key) {
                add_relation(
                    src_ent,
                    ep_ent,
                    RelationKind::Implements,
                    format!("'{}' 문서에 정의됨: {}", p.title, &caps[0]),
                    sref.clone(),
                    0.78,
                )?;
            }
        }
    }

    let active_entities: Vec<KnowledgeEntity> = db
        .knowledge_entities
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|e| e.status != "rejected")
        .collect();
    for task in db.tasks.list_by_project(&project.id)? {
        if task.deleted_at.is_some() || task.description.trim().is_empty() {
            continue;
        }
        let t_ref = SourceRef {
            source_type: "task".into(),
            source_id: task.id.clone(),
            title: format!("{}-{} {}", project.key, task.number, task.title),
            excerpt: first_excerpt(&task.description, 160),
        };
        for sent in split_sentences(&task.description) {
            let sent_cf = sent.to_lowercase();
            let matched: Vec<&KnowledgeEntity> = active_entities
                .iter()
                .filter(|e| e.name.chars().count() >= 2 && sent_cf.contains(&e.name.to_lowercase()))
                .collect();
            if matched.len() >= 2 {
                let rkind = infer_relation_kind(&sent);
                let snippet: String = sent
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(240)
                    .collect();
                add_relation(matched[0], matched[1], rkind, snippet, t_ref.clone(), 0.62)?;
            }
        }
    }

    let pending_entities = db
        .knowledge_entities
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|e| e.status == "pending")
        .count();
    let pending_relations = db
        .knowledge_relations
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|r| r.status == "pending")
        .count();

    Ok(ExtractResult {
        entities_added,
        relations_added,
        pending_entities,
        pending_relations,
    })
}
