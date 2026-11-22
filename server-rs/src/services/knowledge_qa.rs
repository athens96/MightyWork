use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{GlossaryTerm, KnowledgeEntity, Project, QACitation, QAResponse};
use crate::services::graph::full_project_graph;
use crate::services::links::project_pages;
use crate::services::search::make_snippet;

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[가-힣A-Za-z0-9_-]{2,}").unwrap())
}

fn ko_particle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:이란|란|에서|으로|에게|까지|부터|처럼|보다|은|는|이|가|을|를|의|에|로|와|과|도|만|요)$")
            .unwrap()
    })
}

const STOPWORDS: &[&str] = &[
    "무엇", "무슨", "어떻게", "어디", "언제", "누가", "왜", "알려줘", "알려주세요", "설명해줘", "설명",
    "관련", "있는", "있어", "인가요", "인가", "뭐야", "뭔가요", "대해", "대해서", "정리",
    "what", "how", "why", "where", "when", "who", "is", "are", "the", "for", "and", "with", "about",
];

fn extract_keywords(question: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for m in token_re().find_iter(question) {
        let raw = m.as_str().to_lowercase();
        let cleaned = if raw.chars().count() >= 3 {
            ko_particle_re().replace(&raw, "").into_owned()
        } else {
            raw.clone()
        };
        for cand in [cleaned, raw] {
            if cand.chars().count() >= 2
                && !STOPWORDS.contains(&cand.as_str())
                && seen.insert(cand.clone())
            {
                out.push(cand);
            }
        }
    }
    out
}

fn snippet_for(text: &str, terms: &[String]) -> String {
    for t in terms {
        if text.to_lowercase().contains(t) {
            return make_snippet(text, t, 85);
        }
    }
    make_snippet(text, "", 85)
}

pub fn answer_question(db: &Database, project: &Project, question: &str) -> ApiResult<QAResponse> {
    let keywords = extract_keywords(question);
    if keywords.is_empty() {
        return Ok(QAResponse {
            question: question.into(),
            answer: "질문에서 핵심 키워드를 찾지 못했습니다. 문서 제목, 용어, 일감 키 등을 포함해 질문해 보세요.".into(),
            expanded_terms: vec![],
            citations: vec![],
            related_facts: vec![],
            graph_nodes: vec![],
            graph_edges: vec![],
        });
    }

    let terms = db.glossary_terms.list_by_project(&project.id)?;
    let terms_by_id: HashMap<&str, &GlossaryTerm> = terms.iter().map(|g| (g.id.as_str(), g)).collect();
    let pages = project_pages(db, &project.id)?;
    let tasks: Vec<_> = db
        .tasks
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    let entities: Vec<KnowledgeEntity> = db
        .knowledge_entities
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|e| e.status == "approved")
        .collect();
    let relations: Vec<_> = db
        .knowledge_relations
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|r| r.status == "approved")
        .collect();

    // 1) Expand terms via glossary synonyms/broader/narrower + wiki aliases
    let mut expanded = keywords.clone();
    let mut seen_terms: HashSet<String> = expanded.iter().cloned().collect();
    let mut add_term = |val: &str| {
        let v = val.trim().to_lowercase();
        if v.chars().count() >= 2 && seen_terms.insert(v.clone()) {
            expanded.push(v);
        }
    };

    let mut matched_glossary: Vec<&GlossaryTerm> = Vec::new();
    for g in &terms {
        let mut all_names = vec![g.term.as_str()];
        all_names.extend(g.synonyms.iter().map(String::as_str));
        let hit = keywords.iter().any(|k| {
            all_names.iter().any(|n| {
                let nc = n.to_lowercase();
                nc.contains(k.as_str()) || k.contains(nc.as_str())
            })
        });
        if hit {
            matched_glossary.push(g);
            for n in all_names {
                add_term(n);
            }
            if let Some(bid) = g.broader_id.as_deref() {
                if let Some(broader) = terms_by_id.get(bid) {
                    add_term(&broader.term);
                }
            }
            for child in &terms {
                if child.broader_id.as_deref() == Some(g.id.as_str()) {
                    add_term(&child.term);
                }
            }
        }
    }
    for p in &pages {
        if keywords
            .iter()
            .any(|k| p.aliases.iter().any(|a| a.to_lowercase().contains(k.as_str())))
        {
            add_term(&p.title);
        }
    }

    // 2) Seed nodes & citations
    let mut seed_ids: HashSet<String> = HashSet::new();
    let mut citations: Vec<(f64, QACitation)> = Vec::new();

    for g in &matched_glossary {
        seed_ids.insert(format!("glossary:{}", g.id));
        if let Some(wid) = &g.wiki_page_id {
            seed_ids.insert(format!("wiki:{wid}"));
        }
        let snippet = if !g.definition.is_empty() {
            g.definition.clone()
        } else if !g.synonyms.is_empty() {
            format!("동의어: {}", g.synonyms.join(", "))
        } else {
            "용어집 항목".into()
        };
        citations.push((
            20.0,
            QACitation {
                kind: "glossary",
                id: g.id.clone(),
                title: g.term.clone(),
                snippet,
                number: None,
                link: format!("/projects/{}/knowledge?tab=glossary", project.id),
            },
        ));
    }

    let entities_by_id: HashMap<&str, &KnowledgeEntity> =
        entities.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut matched_entities: Vec<(f64, &KnowledgeEntity)> = Vec::new();
    for e in &entities {
        let mut names = vec![e.name.to_lowercase()];
        names.extend(e.aliases.iter().map(|a| a.to_lowercase()));
        let mut score: f64 = expanded
            .iter()
            .filter(|t| names.iter().any(|n| n.contains(t.as_str())))
            .count() as f64
            * 8.0;
        if score == 0.0 {
            let desc_cf = e.description.to_lowercase();
            if expanded.iter().any(|t| desc_cf.contains(t.as_str())) {
                score = 4.0;
            }
        }
        if score > 0.0 {
            matched_entities.push((score, e));
            seed_ids.insert(format!("entity:{}", e.id));
            citations.push((
                15.0 + score,
                QACitation {
                    kind: "entity",
                    id: e.id.clone(),
                    title: format!("{} ({})", e.name, e.kind.as_str()),
                    snippet: if e.description.is_empty() {
                        "승인된 지식 엔티티".into()
                    } else {
                        e.description.clone()
                    },
                    number: None,
                    link: format!("/projects/{}/knowledge?tab=review", project.id),
                },
            ));
        }
    }

    for p in &pages {
        let title_cf = p.title.to_lowercase();
        let body_cf = p.content.to_lowercase();
        let aliases_cf: Vec<String> = p.aliases.iter().map(|a| a.to_lowercase()).collect();
        let mut score = 0.0;
        for t in &expanded {
            if title_cf.contains(t.as_str()) || aliases_cf.iter().any(|a| a.contains(t.as_str())) {
                score += 10.0;
            }
            if body_cf.contains(t.as_str()) {
                score += 3.0;
            }
        }
        if score > 0.0 {
            seed_ids.insert(format!("wiki:{}", p.id));
            citations.push((
                score,
                QACitation {
                    kind: "wiki",
                    id: p.id.clone(),
                    title: p.title.clone(),
                    snippet: snippet_for(&p.content, &expanded),
                    number: None,
                    link: format!("/projects/{}/wiki/{}", project.id, p.id),
                },
            ));
        }
    }

    for task in &tasks {
        let key_str = format!("{}-{}", project.key, task.number).to_lowercase();
        let title_cf = task.title.to_lowercase();
        let blob = format!(
            "{} {} {} {}",
            key_str,
            title_cf,
            task.tags.join(" ").to_lowercase(),
            task.description.to_lowercase()
        );
        let mut score = 0.0;
        for t in &expanded {
            if t == &key_str {
                score += 25.0;
            } else if title_cf.contains(t.as_str()) {
                score += 8.0;
            } else if blob.contains(t.as_str()) {
                score += 3.0;
            }
        }
        if score > 0.0 {
            seed_ids.insert(format!("task:{}", task.id));
            let src = if task.description.is_empty() {
                &task.title
            } else {
                &task.description
            };
            citations.push((
                score,
                QACitation {
                    kind: "task",
                    id: task.id.clone(),
                    title: task.title.clone(),
                    snippet: snippet_for(src, &expanded),
                    number: Some(task.number),
                    link: format!("/projects/{}/tasks/{}", project.id, task.id),
                },
            ));
        }
    }

    // 3) 1-hop graph neighborhood around seeds
    let graph = full_project_graph(db, project, true, 300)?;
    let nodes_by_id: HashMap<String, _> = graph.nodes.into_iter().map(|n| (n.id.clone(), n)).collect();
    let mut sub_node_ids = seed_ids.clone();
    let mut sub_edges = Vec::new();
    for e in graph.edges {
        if seed_ids.contains(&e.source) || seed_ids.contains(&e.target) {
            sub_node_ids.insert(e.source.clone());
            sub_node_ids.insert(e.target.clone());
            sub_edges.push(e);
        }
    }

    // 4) Facts
    let matched_entity_ids: HashSet<&str> = matched_entities.iter().map(|(_, e)| e.id.as_str()).collect();
    let mut related_facts = Vec::new();
    for r in &relations {
        if matched_entity_ids.contains(r.source_entity_id.as_str())
            || matched_entity_ids.contains(r.target_entity_id.as_str())
        {
            if let (Some(s_ent), Some(t_ent)) = (
                entities_by_id.get(r.source_entity_id.as_str()),
                entities_by_id.get(r.target_entity_id.as_str()),
            ) {
                let ev = if r.evidence.is_empty() {
                    String::new()
                } else {
                    format!(" — {}", r.evidence)
                };
                related_facts.push(format!(
                    "{} → [{}] → {}{}",
                    s_ent.name,
                    r.kind.ko_label(),
                    t_ent.name,
                    ev
                ));
            }
        }
    }
    for g in &matched_glossary {
        if let Some(bid) = g.broader_id.as_deref() {
            if let Some(broader) = terms_by_id.get(bid) {
                related_facts.push(format!(
                    "용어 '{}' 의 상위 개념은 '{}' 입니다.",
                    g.term, broader.term
                ));
            }
        }
        let narrower: Vec<&str> = terms
            .iter()
            .filter(|c| c.broader_id.as_deref() == Some(g.id.as_str()))
            .map(|c| c.term.as_str())
            .collect();
        if !narrower.is_empty() {
            related_facts.push(format!("용어 '{}' 의 하위 개념: {}", g.term, narrower.join(", ")));
        }
    }

    // 5) Answer composition
    citations.sort_by(|a, b| b.0.total_cmp(&a.0));
    let top_citations: Vec<QACitation> = citations.into_iter().take(8).map(|(_, c)| c).collect();
    let mut sections = Vec::new();
    if !matched_glossary.is_empty() {
        let defs: Vec<String> = matched_glossary
            .iter()
            .take(3)
            .map(|g| {
                let def = if g.definition.is_empty() {
                    "정의 미입력"
                } else {
                    &g.definition
                };
                let syn = if g.synonyms.is_empty() {
                    String::new()
                } else {
                    format!(" (동의어: {})", g.synonyms.join(", "))
                };
                format!("- **{}**: {}{}", g.term, def, syn)
            })
            .collect();
        sections.push(format!("### 용어 정의\n{}", defs.join("\n")));
    }
    if !related_facts.is_empty() {
        let facts: Vec<String> = related_facts.iter().take(6).map(|f| format!("- {f}")).collect();
        sections.push(format!("### 지식 그래프 관계\n{}", facts.join("\n")));
    }
    let doc_cites: Vec<&QACitation> = top_citations
        .iter()
        .filter(|c| c.kind == "wiki" || c.kind == "task")
        .take(4)
        .collect();
    if !doc_cites.is_empty() {
        let lines: Vec<String> = doc_cites
            .iter()
            .map(|c| {
                let num = c
                    .number
                    .map(|n| format!(" ({}-{n})", project.key))
                    .unwrap_or_default();
                let sn = if c.snippet.is_empty() {
                    String::new()
                } else {
                    format!(": {}", c.snippet)
                };
                format!("- **{}**{}{}", c.title, num, sn)
            })
            .collect();
        sections.push(format!("### 관련 문서 · 일감 근거\n{}", lines.join("\n")));
    }

    let answer = if sections.is_empty() {
        format!("'{question}' 와 직접 일치하는 용어·엔티티·문서를 찾지 못했습니다. 위키 문서를 작성하거나 지식 추출을 실행해 보세요.")
    } else {
        sections.join("\n\n")
    };

    let sub_nodes: Vec<Value> = sub_node_ids
        .iter()
        .filter_map(|nid| nodes_by_id.get(nid))
        .take(40)
        .filter_map(|n| serde_json::to_value(n).ok())
        .collect();
    let kept: HashSet<String> = sub_nodes
        .iter()
        .filter_map(|v| v.get("id").and_then(|x| x.as_str()).map(str::to_string))
        .collect();
    let out_edges: Vec<Value> = sub_edges
        .into_iter()
        .filter(|e| kept.contains(&e.source) && kept.contains(&e.target))
        .take(60)
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect();

    Ok(QAResponse {
        question: question.into(),
        answer,
        expanded_terms: expanded.into_iter().take(15).collect(),
        citations: top_citations,
        related_facts: related_facts.into_iter().take(10).collect(),
        graph_nodes: sub_nodes,
        graph_edges: out_edges,
    })
}
