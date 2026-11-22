use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{Project, Task, WikiPage};

fn wiki_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]").unwrap())
}

fn code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)```.*?```|`[^`\n]*`").unwrap())
}

pub fn norm_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn strip_code(md: &str) -> String {
    code_re().replace_all(md, " ").into_owned()
}

pub fn link_targets(md: &str) -> Vec<String> {
    let clean = strip_code(md);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for caps in wiki_link_re().captures_iter(&clean) {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let key = norm_title(raw);
        if !key.is_empty() && seen.insert(key) {
            out.push(raw.trim().to_string());
        }
    }
    out
}

pub fn task_numbers(md: &str, project_key: &str) -> Vec<i64> {
    let clean = strip_code(md);
    let pat = format!(r"{}-(\d+)", regex::escape(project_key));
    let Ok(re) = Regex::new(&pat) else {
        return vec![];
    };
    let bytes = clean.as_bytes();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for caps in re.captures_iter(&clean) {
        let m = caps.get(0).unwrap();
        let before_ok = m.start() == 0
            || !matches!(
                bytes[m.start() - 1],
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'
            );
        let after_ok = m.end() == bytes.len()
            || !matches!(bytes[m.end()], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_');
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

pub fn project_pages(db: &Database, project_id: &str) -> ApiResult<Vec<WikiPage>> {
    Ok(db
        .wiki_pages
        .list_by_project(project_id)?
        .into_iter()
        .filter(|p| p.deleted_at.is_none())
        .collect())
}

pub fn pages_by_title(pages: &[WikiPage]) -> HashMap<String, WikiPage> {
    let mut ordered = pages.to_vec();
    ordered.sort_by_key(|p| p.created_at);
    let mut out = HashMap::new();
    for p in &ordered {
        out.entry(norm_title(&p.title)).or_insert_with(|| p.clone());
    }
    for p in &ordered {
        for alias in &p.aliases {
            out.entry(norm_title(alias)).or_insert_with(|| p.clone());
        }
    }
    out
}

pub fn rename_links(md: &str, old_title: &str, new_title: &str) -> String {
    let old_key = norm_title(old_title);
    let mut result = String::with_capacity(md.len());
    let mut last = 0;
    let replace_chunk = |chunk: &str| -> String {
        wiki_link_re()
            .replace_all(chunk, |caps: &regex::Captures| {
                let target = &caps[1];
                if norm_title(target) != old_key {
                    return caps[0].to_string();
                }
                match caps.get(2) {
                    Some(alias) => format!("[[{new_title}|{}]]", alias.as_str()),
                    None => format!("[[{new_title}]]"),
                }
            })
            .into_owned()
    };

    for m in code_re().find_iter(md) {
        result.push_str(&replace_chunk(&md[last..m.start()]));
        result.push_str(m.as_str());
        last = m.end();
    }
    result.push_str(&replace_chunk(&md[last..]));
    result
}

pub fn propagate_rename(db: &Database, project: &Project, page: &WikiPage, old_title: &str) -> ApiResult<usize> {
    if norm_title(old_title) == norm_title(&page.title) {
        return Ok(0);
    }
    let mut changed = 0;
    for mut p in project_pages(db, &project.id)? {
        if p.id == page.id {
            continue;
        }
        let next = rename_links(&p.content, old_title, &page.title);
        if next != p.content {
            p.content = next;
            db.wiki_pages.update(&p)?;
            changed += 1;
        }
    }
    for mut t in db
        .tasks
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
    {
        let next = rename_links(&t.description, old_title, &page.title);
        if next != t.description {
            t.description = next;
            db.tasks.update(&t)?;
            changed += 1;
        }
    }
    Ok(changed)
}

pub fn backlinks(pages: &[WikiPage], target_page_id: &str) -> Vec<WikiPage> {
    let by_title = pages_by_title(pages);
    pages
        .iter()
        .filter(|p| {
            p.id != target_page_id
                && link_targets(&p.content)
                    .iter()
                    .any(|t| by_title.get(&norm_title(t)).is_some_and(|x| x.id == target_page_id))
        })
        .cloned()
        .collect()
}

pub fn pages_mentioning_task(db: &Database, project: &Project, task: &Task) -> ApiResult<Vec<WikiPage>> {
    let pages = project_pages(db, &project.id)?;
    Ok(pages
        .into_iter()
        .filter(|p| task_numbers(&p.content, &project.key).contains(&task.number))
        .collect())
}
