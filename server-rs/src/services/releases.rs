use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use chrono::{DateTime, NaiveDate, Utc};
use regex::Regex;
use serde::Serialize;

use crate::models::{PipelineStage, Priority, Project, Task};

fn ver_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^v?(\d+)\.(\d+|x|\*)(?:\.(\d+|x|\*))?").unwrap())
}

const BUG_KEYWORDS: &[&str] = &["bug", "fix", "hotfix", "error", "버그", "수정", "오류", "장애"];
const UX_KEYWORDS: &[&str] = &[
    "ux", "ui", "dx", "perf", "performance", "responsive", "mobile", "pwa", "organization", "refactor", "개선",
];
const INFRA_KEYWORDS: &[&str] = &[
    "infra", "deploy", "ci", "ci-cd", "github", "github-actions", "webhook", "migration", "versioning",
    "security", "config", "docs", "testing", "e2e", "release",
];

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseTaskItem {
    pub id: String,
    pub number: i64,
    pub key: String,
    pub title: String,
    pub stage: PipelineStage,
    pub priority: Priority,
    pub tags: Vec<String>,
    pub estimate: Option<i64>,
    pub assignee_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseSummary {
    pub version: String,
    pub status: &'static str,
    pub total_tasks: usize,
    pub done_tasks: usize,
    pub in_progress_tasks: usize,
    pub todo_tasks: usize,
    pub total_points: i64,
    pub done_points: i64,
    pub progress_pct: i64,
    pub latest_updated_at: Option<DateTime<Utc>>,
    pub tasks: Vec<ReleaseTaskItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseListResponse {
    pub releases: Vec<ReleaseSummary>,
    pub unversioned_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseChangelogResponse {
    pub version: String,
    pub markdown: String,
    pub total_tasks: usize,
    pub done_tasks: usize,
    pub included_tasks: usize,
}

pub fn version_sort_key(version: &str) -> (u8, i64, i64, i64, i64, String) {
    let cleaned = version.trim().split('-').next().unwrap_or("");
    let Some(caps) = ver_re().captures(cleaned) else {
        return (1, 0, 0, 0, 0, version.to_lowercase());
    };
    let major: i64 = caps[1].parse().unwrap_or(0);
    let minor_raw = &caps[2];
    let patch_raw = caps.get(3).map(|m| m.as_str());
    let minor: i64 = if minor_raw.chars().all(|c| c.is_ascii_digit()) {
        minor_raw.parse().unwrap_or(0)
    } else {
        1_000_000_000
    };
    let patch: i64 = match patch_raw {
        None => -1,
        Some(p) if p.chars().all(|c| c.is_ascii_digit()) => p.parse().unwrap_or(0),
        Some(_) => 1_000_000_000,
    };
    let is_wild: i64 = if cleaned.to_lowercase().contains('x') || cleaned.contains('*') {
        1
    } else {
        0
    };
    (0, -major, -minor, -patch, -is_wild, version.to_lowercase())
}

pub fn build_releases(project: &Project, all_tasks: &[Task]) -> ReleaseListResponse {
    let mut buckets: HashMap<String, Vec<&Task>> = HashMap::new();
    let mut unversioned = 0usize;

    for t in all_tasks.iter().filter(|t| t.triage_status.is_none()) {
        match t.version.as_deref().filter(|v| !v.is_empty()) {
            None => unversioned += 1,
            Some(ver) => buckets.entry(ver.to_string()).or_default().push(t),
        }
    }

    let mut versions: Vec<String> = buckets.keys().cloned().collect();
    versions.sort_by_key(|v| version_sort_key(v));

    let mut releases = Vec::with_capacity(versions.len());
    for ver in versions {
        let mut items = buckets.remove(&ver).unwrap_or_default();
        items.sort_by_key(|t| t.number);
        let total = items.len();
        let done = items.iter().filter(|t| t.stage == PipelineStage::Done).count();
        let in_prog = items
            .iter()
            .filter(|t| {
                matches!(
                    t.stage,
                    PipelineStage::InProgress | PipelineStage::Review | PipelineStage::Qa
                )
            })
            .count();
        let todo = total.saturating_sub(done + in_prog);
        let total_pts: i64 = items.iter().map(|t| t.estimate.unwrap_or(0)).sum();
        let done_pts: i64 = items
            .iter()
            .filter(|t| t.stage == PipelineStage::Done)
            .map(|t| t.estimate.unwrap_or(0))
            .sum();
        let pct = if total > 0 {
            ((done as f64 / total as f64) * 100.0).round() as i64
        } else {
            0
        };
        let status = if total > 0 && done == total {
            "released"
        } else if done > 0 || in_prog > 0 {
            "in_progress"
        } else {
            "planned"
        };
        let latest = items.iter().map(|t| t.updated_at).max();
        releases.push(ReleaseSummary {
            version: ver,
            status,
            total_tasks: total,
            done_tasks: done,
            in_progress_tasks: in_prog,
            todo_tasks: todo,
            total_points: total_pts,
            done_points: done_pts,
            progress_pct: pct,
            latest_updated_at: latest,
            tasks: items
                .into_iter()
                .map(|t| ReleaseTaskItem {
                    id: t.id.clone(),
                    number: t.number,
                    key: format!("{}-{}", project.key, t.number),
                    title: t.title.clone(),
                    stage: t.stage,
                    priority: t.priority,
                    tags: t.tags.clone(),
                    estimate: t.estimate,
                    assignee_id: t.assignee_id.clone(),
                    updated_at: t.updated_at,
                })
                .collect(),
        });
    }

    ReleaseListResponse {
        releases,
        unversioned_count: unversioned,
    }
}

fn classify_task(task: &Task) -> &'static str {
    let tags_cf: HashSet<String> = task.tags.iter().map(|t| t.to_lowercase()).collect();
    let title_cf = task.title.to_lowercase();
    if BUG_KEYWORDS.iter().any(|k| tags_cf.contains(*k))
        || ["버그", "오류", "fix:", "bug:"].iter().any(|k| title_cf.contains(k))
    {
        return "bug";
    }
    if UX_KEYWORDS.iter().any(|k| tags_cf.contains(*k)) {
        return "ux";
    }
    if INFRA_KEYWORDS.iter().any(|k| tags_cf.contains(*k)) {
        return "infra";
    }
    "feat"
}

pub fn build_changelog(
    project: &Project,
    all_tasks: &[Task],
    version: &str,
    include_unfinished: bool,
    release_date: Option<NaiveDate>,
) -> Option<ReleaseChangelogResponse> {
    let ver_cf = version.trim().to_lowercase();
    let mut matched: Vec<&Task> = all_tasks
        .iter()
        .filter(|t| {
            t.triage_status.is_none()
                && t.version
                    .as_deref()
                    .is_some_and(|v| v.to_lowercase() == ver_cf)
        })
        .collect();
    if matched.is_empty() {
        return None;
    }
    matched.sort_by_key(|t| t.number);
    let canonical_version = matched[0]
        .version
        .clone()
        .unwrap_or_else(|| version.trim().to_string());
    let done_items: Vec<&Task> = matched
        .iter()
        .copied()
        .filter(|t| t.stage == PipelineStage::Done)
        .collect();
    let unfinished: Vec<&Task> = matched
        .iter()
        .copied()
        .filter(|t| t.stage != PipelineStage::Done)
        .collect();
    let total = matched.len();
    let done_count = done_items.len();
    let pct = if total > 0 {
        ((done_count as f64 / total as f64) * 100.0).round() as i64
    } else {
        0
    };
    let day = release_date
        .unwrap_or_else(|| Utc::now().date_naive())
        .format("%Y-%m-%d")
        .to_string();

    let mut lines = vec![
        format!("## {} {} ({})", project.name, canonical_version, day),
        String::new(),
        format!("> 총 {total}건 중 {done_count}건 완료 ({pct}%)"),
        String::new(),
    ];

    let sections = [
        ("feat", "### ✨ 주요 기능"),
        ("ux", "### ⚡ UX · 성능 개선"),
        ("bug", "### 🐛 버그 수정"),
        ("infra", "### 🔧 인프라 · 연동 · 설정"),
    ];
    let mut grouped: HashMap<&str, Vec<&Task>> = HashMap::new();
    for t in &done_items {
        grouped.entry(classify_task(t)).or_default().push(*t);
    }

    if !done_items.is_empty() {
        for (key, heading) in sections {
            if let Some(bucket) = grouped.get(key) {
                if !bucket.is_empty() {
                    lines.push(heading.to_string());
                    for t in bucket {
                        lines.push(format!("- **{}-{}** {}", project.key, t.number, t.title));
                    }
                    lines.push(String::new());
                }
            }
        }
    } else {
        lines.push("_아직 완료된 일감이 없습니다._".into());
        lines.push(String::new());
    }

    let mut included = done_count;
    if include_unfinished && !unfinished.is_empty() {
        lines.push("### 🚧 진행 중 · 예정".into());
        for t in &unfinished {
            lines.push(format!(
                "- [ ] **{}-{}** {} ({})",
                project.key,
                t.number,
                t.title,
                t.stage.label()
            ));
        }
        lines.push(String::new());
        included += unfinished.len();
    }

    let markdown = format!("{}\n", lines.join("\n").trim_end());
    Some(ReleaseChangelogResponse {
        version: canonical_version,
        markdown,
        total_tasks: total,
        done_tasks: done_count,
        included_tasks: included,
    })
}
