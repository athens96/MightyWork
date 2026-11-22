use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{Project, Task, WikiPage};

pub fn wiki_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]").unwrap())
}

pub fn code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)```.*?```|`[^`\n]*`").unwrap())
}

fn mask_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)```.*?```|`[^`\n]*`|\[\[[^\[\]\n]*\]\]|\[[^\[\]\n]*\]\([^)\n]*\)").unwrap()
    })
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

pub fn page_names(page: &WikiPage) -> Vec<String> {
    let mut out = Vec::with_capacity(1 + page.aliases.len());
    out.push(page.title.clone());
    out.extend(page.aliases.iter().cloned());
    out
}

fn masked(md: &str) -> String {
    mask_re()
        .replace_all(md, |caps: &regex::Captures| " ".repeat(caps[0].len()))
        .into_owned()
}

pub fn find_mentions(md: &str, names: &[String]) -> Vec<(usize, usize, String)> {
    let mut uniq: Vec<String> = names
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| s.chars().count() >= 2)
        .collect();
    uniq.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then_with(|| a.cmp(b)));
    uniq.dedup();
    if uniq.is_empty() {
        return vec![];
    }
    let alts: Vec<String> = uniq
        .iter()
        .map(|n| {
            n.split_whitespace()
                .map(regex::escape)
                .collect::<Vec<_>>()
                .join(r"\s+")
        })
        .collect();
    let pat = format!(r"(?i)(?:{})", alts.join("|"));
    let Ok(re) = Regex::new(&pat) else {
        return vec![];
    };
    let m_text = masked(md);
    let bytes = m_text.as_bytes();
    let mut out = Vec::new();
    for m in re.find_iter(&m_text) {
        let before_ok = m.start() == 0
            || !matches!(
                bytes[m.start() - 1],
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'
            );
        let after_ok = m.end() == bytes.len()
            || !matches!(bytes[m.end()], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_');
        if before_ok && after_ok {
            out.push((m.start(), m.end(), md[m.start()..m.end()].to_string()));
        }
    }
    out
}

pub fn slice_chars_around(s: &str, byte_start: usize, byte_end: usize, char_width: usize) -> (String, usize) {
    let mut a = byte_start;
    let mut steps = 0;
    for (idx, _) in s[..byte_start].char_indices().rev() {
        a = idx;
        steps += 1;
        if steps >= char_width {
            break;
        }
    }
    let mut b = byte_end;
    steps = 0;
    for (rel_idx, ch) in s[byte_end..].char_indices() {
        b = byte_end + rel_idx + ch.len_utf8();
        steps += 1;
        if steps >= char_width {
            break;
        }
    }
    let prefix = if a > 0 { "…" } else { "" };
    let suffix = if b < s.len() { "…" } else { "" };
    let mid = s[a..b].split_whitespace().collect::<Vec<_>>().join(" ");
    (format!("{prefix}{mid}{suffix}"), b)
}

pub fn mention_snippets(md: &str, spans: &[(usize, usize, String)], width: usize, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut covered_until: usize = 0;
    for (start, end, _) in spans {
        if *start < covered_until {
            continue;
        }
        let (snippet, b) = slice_chars_around(md, *start, *end, width);
        out.push(snippet);
        covered_until = b;
        if out.len() >= limit {
            break;
        }
    }
    out
}

pub fn link_mentions(md: &str, page: &WikiPage) -> String {
    let spans = find_mentions(md, &page_names(page));
    let mut out = String::with_capacity(md.len() + spans.len() * 8);
    let mut last = 0;
    let title_norm = norm_title(&page.title);
    for (start, end, text) in spans {
        out.push_str(&md[last..start]);
        if norm_title(&text) == title_norm {
            out.push_str(&format!("[[{}]]", page.title));
        } else {
            out.push_str(&format!("[[{}|{}]]", page.title, text));
        }
        last = end;
    }
    out.push_str(&md[last..]);
    out
}

pub fn resolve_links(
    md: &str,
    db: &Database,
    project: &Project,
    bundle_ids: Option<&HashSet<String>>,
) -> String {
    let pages = project_pages(db, &project.id).unwrap_or_default();
    let by_title = pages_by_title(&pages);
    let replace_chunk = |chunk: &str| -> String {
        wiki_link_re()
            .replace_all(chunk, |caps: &regex::Captures| {
                let raw_target = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let label = caps
                    .get(2)
                    .map(|m| m.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(raw_target)
                    .trim();
                if let (Some(ids), Some(target)) = (bundle_ids, by_title.get(&norm_title(raw_target))) {
                    if ids.contains(&target.id) {
                        return format!("[{label}](#page-{})", target.id);
                    }
                }
                label.to_string()
            })
            .into_owned()
    };
    let mut result = String::with_capacity(md.len());
    let mut last = 0;
    for m in code_re().find_iter(md) {
        result.push_str(&replace_chunk(&md[last..m.start()]));
        result.push_str(m.as_str());
        last = m.end();
    }
    result.push_str(&replace_chunk(&md[last..]));
    result
}
