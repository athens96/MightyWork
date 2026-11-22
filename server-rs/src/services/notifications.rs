use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::json;

use crate::db::Database;
use crate::models::{new_id, utcnow, Notification, Project, User};
use crate::services::access::project_related_users;
use crate::services::events::{publish_user_event, EventBus};
use crate::services::links::strip_code;

fn mention_email_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})").unwrap())
}

fn mention_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"@([^\s@,;:\[\]()\"'`<>]{2,40})"#).unwrap())
}

fn before_mention_ok(text: &str, start: usize) -> bool {
    if start == 0 {
        return true;
    }
    let prev = text.as_bytes()[start - 1];
    !matches!(
        prev,
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'%' | b'+' | b'-'
    )
}

pub fn parse_mentioned_users(db: &Database, project: &Project, text: &str) -> Vec<User> {
    if !text.contains('@') {
        return vec![];
    }
    let clean = strip_code(text);
    let candidates = project_related_users(db, project).unwrap_or_default();
    let mut by_email = HashMap::new();
    let mut by_local = HashMap::new();
    let mut by_name = HashMap::new();
    for u in &candidates {
        let email_lc = u.email.to_lowercase();
        let local = email_lc.split('@').next().unwrap_or("").to_string();
        by_email.insert(email_lc, u.clone());
        by_local.entry(local).or_insert_with(|| u.clone());
        let name = u.name.trim().to_lowercase();
        if !name.is_empty() {
            by_name.entry(name).or_insert_with(|| u.clone());
        }
    }

    let mut found: HashMap<String, User> = HashMap::new();
    for caps in mention_email_re().captures_iter(&clean) {
        let m = caps.get(0).unwrap();
        if before_mention_ok(&clean, m.start()) {
            if let Some(u) = by_email.get(&caps[1].to_lowercase()) {
                found.insert(u.id.clone(), u.clone());
            }
        }
    }
    for caps in mention_token_re().captures_iter(&clean) {
        let m = caps.get(0).unwrap();
        if !before_mention_ok(&clean, m.start()) {
            continue;
        }
        let raw = caps[1].trim_end_matches(|c| matches!(c, '.' | ',' | '!' | '?' | ':' | ';' | ')'));
        let key = raw.to_lowercase();
        if let Some(u) = by_email.get(&key).or_else(|| by_local.get(&key)).or_else(|| by_name.get(&key)) {
            found.insert(u.id.clone(), u.clone());
        }
    }
    found.into_values().collect()
}

pub fn notify_user(
    db: &Database,
    bus: &EventBus,
    user_id: &str,
    project_id: &str,
    actor_id: &str,
    kind: &str,
    title: &str,
    body: &str,
    link: &str,
) -> Option<Notification> {
    if user_id == actor_id {
        return None;
    }
    let now = utcnow();
    let n = Notification {
        id: new_id(),
        created_at: now,
        updated_at: now,
        user_id: user_id.to_string(),
        project_id: project_id.to_string(),
        actor_id: actor_id.to_string(),
        kind: kind.to_string(),
        title: title.chars().take(200).collect(),
        body: body.chars().take(500).collect(),
        link: link.to_string(),
        read: false,
    };
    let created = db.notifications.create(&n).ok()?;
    publish_user_event(
        db,
        bus,
        user_id,
        "notification.created",
        json!({ "notification_id": created.id, "project_id": project_id, "kind": kind }),
    );
    Some(created)
}

pub fn notify_mentions(
    db: &Database,
    bus: &EventBus,
    project: &Project,
    actor: &User,
    text: &str,
    title: &str,
    link: &str,
) -> Vec<Notification> {
    let mut excluded = HashSet::new();
    excluded.insert(actor.id.clone());
    let excerpt: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(140)
        .collect();
    let mut created = Vec::new();
    for target in parse_mentioned_users(db, project, text) {
        if excluded.contains(&target.id) {
            continue;
        }
        if let Some(n) = notify_user(
            db,
            bus,
            &target.id,
            &project.id,
            &actor.id,
            "mention",
            title,
            &excerpt,
            link,
        ) {
            created.push(n);
        }
    }
    created
}
