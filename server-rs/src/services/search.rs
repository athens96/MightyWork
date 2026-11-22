use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::Project;
use crate::services::links::wiki_link_re;

fn md_noise_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[#>*_`~\[\]|]+").unwrap())
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub kind: &'static str,
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub number: Option<i64>,
    pub stage: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalSearchHit {
    pub kind: &'static str,
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub number: Option<i64>,
    pub stage: Option<String>,
    pub project_id: String,
    pub project_key: String,
    pub project_name: String,
}

fn take_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

pub fn make_snippet(text: &str, q_cf: &str, width: usize) -> String {
    let unlinked = wiki_link_re().replace_all(text, |caps: &regex::Captures| {
        let alias = caps.get(2).map(|m| m.as_str()).filter(|s| !s.trim().is_empty());
        alias.unwrap_or(&caps[1]).trim().to_string()
    });
    let plain = md_noise_re()
        .replace_all(&unlinked, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let plain_chars: Vec<char> = plain.chars().collect();
    let lower_chars: Vec<char> = plain.to_lowercase().chars().collect();
    let q_chars: Vec<char> = q_cf.chars().collect();

    if q_chars.is_empty() || q_chars.len() > lower_chars.len() {
        return take_chars(&plain, width * 2);
    }

    // Find char index match (handles Korean & ASCII cleanly without byte mismatch)
    let mut found_idx = None;
    for i in 0..=(lower_chars.len() - q_chars.len()) {
        if lower_chars[i..i + q_chars.len()] == q_chars[..] {
            found_idx = Some(i);
            break;
        }
    }
    let Some(i) = found_idx else {
        return take_chars(&plain, width * 2);
    };
    let start = i.saturating_sub(width);
    let end = (i + q_chars.len() + width).min(plain_chars.len());
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < plain_chars.len() { "…" } else { "" };
    let mid: String = plain_chars[start..end].iter().collect();
    format!("{prefix}{mid}{suffix}")
}

pub fn search_project(
    db: &Database,
    project: &Project,
    query: &str,
    limit: usize,
) -> ApiResult<Vec<SearchHit>> {
    let q = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let key_prefix = format!("{}-", project.key.to_lowercase());
    let exact_key_num: Option<i64> = q
        .strip_prefix(&key_prefix)
        .filter(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        .and_then(|rest| rest.parse().ok());

    let (mut task_ids, wiki_ids) = db.engine.search_candidates(&project.id, &q)?;
    if let Some(target_num) = exact_key_num {
        for t in db.tasks.list_by_project(&project.id)? {
            if t.deleted_at.is_none() && t.number == target_num {
                task_ids.insert(t.id);
            }
        }
    }

    let mut tasks = Vec::new();
    for tid in &task_ids {
        if let Some(t) = db.tasks.get(tid)? {
            if t.project_id == project.id && t.deleted_at.is_none() {
                tasks.push(t);
            }
        }
    }
    let mut pages = Vec::new();
    for pid in &wiki_ids {
        if let Some(p) = db.wiki_pages.get(pid)? {
            if p.project_id == project.id && p.deleted_at.is_none() {
                pages.push(p);
            }
        }
    }
    let mut comments_by_task: HashMap<String, Vec<String>> = HashMap::new();
    if !task_ids.is_empty() {
        for c in db.comments.list_by_project(&project.id)? {
            if task_ids.contains(&c.task_id) {
                comments_by_task.entry(c.task_id).or_default().push(c.body);
            }
        }
    }

    let mut hits = Vec::new();
    for t in tasks {
        let (score, body) = if exact_key_num == Some(t.number) {
            (100.0, t.description.clone())
        } else {
            let mut s = 0.0;
            if t.title.to_lowercase().contains(&q) {
                s += 10.0;
            }
            if t.version.as_deref().is_some_and(|v| v.to_lowercase().contains(&q)) {
                s += 6.0;
            }
            if t.tags.iter().any(|tag| tag.to_lowercase().contains(&q)) {
                s += 5.0;
            }
            let mut parts: Vec<&str> = Vec::new();
            parts.push(&t.description);
            for item in &t.checklist {
                parts.push(&item.text);
            }
            if let Some(cs) = comments_by_task.get(&t.id) {
                for c in cs {
                    parts.push(c);
                }
            }
            let matched: Vec<&str> = parts
                .into_iter()
                .filter(|p| p.to_lowercase().contains(&q))
                .collect();
            let mut b = String::new();
            if !matched.is_empty() {
                s += 2.0 + (matched.len().min(3) as f64);
                b = matched[0].to_string();
            }
            if s == 0.0 {
                continue;
            }
            (s, b)
        };
        let snippet_src = if body.is_empty() { &t.description } else { &body };
        hits.push(SearchHit {
            kind: "task",
            id: t.id,
            title: t.title,
            snippet: make_snippet(snippet_src, &q, 70),
            score,
            number: Some(t.number),
            stage: Some(t.stage.as_str().into()),
        });
    }

    for p in pages {
        let mut score = if p.title.to_lowercase().contains(&q) {
            10.0
        } else if p.aliases.iter().any(|a| a.to_lowercase().contains(&q)) {
            8.0
        } else {
            0.0
        };
        if p.tags.iter().any(|t| t.to_lowercase().contains(&q)) {
            score += 5.0;
        }
        let count = p.content.to_lowercase().matches(&q).count();
        if count > 0 {
            score += (count.min(5) as f64) + 2.0;
        }
        if score > 0.0 {
            hits.push(SearchHit {
                kind: "wiki",
                id: p.id,
                title: p.title,
                snippet: make_snippet(&p.content, &q, 70),
                score,
                number: None,
                stage: None,
            });
        }
    }

    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(limit);
    Ok(hits)
}

pub fn search_global(
    db: &Database,
    projects: &[Project],
    query: &str,
    limit: usize,
    prefer_project_id: Option<&str>,
) -> ApiResult<Vec<GlobalSearchHit>> {
    let q = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if q.is_empty() || projects.is_empty() {
        return Ok(vec![]);
    }
    let mut combined = Vec::new();
    for p in projects {
        let bonus = if prefer_project_id == Some(p.id.as_str()) {
            0.5
        } else {
            0.0
        };
        for h in search_project(db, p, &q, limit)? {
            combined.push(GlobalSearchHit {
                kind: h.kind,
                id: h.id,
                title: h.title,
                snippet: h.snippet,
                score: h.score + bonus,
                number: h.number,
                stage: h.stage,
                project_id: p.id.clone(),
                project_key: p.key.clone(),
                project_name: p.name.clone(),
            });
        }
    }
    combined.sort_by(|a, b| b.score.total_cmp(&a.score));
    combined.truncate(limit);
    Ok(combined)
}
