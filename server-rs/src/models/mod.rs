pub mod phase2;
pub use phase2::*;

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub fn new_id() -> String {
    Uuid::new_v4().simple().to_string()
}

pub fn utcnow() -> DateTime<Utc> {
    Utc::now()
}

/// PATCH 요청에서 "필드 생략(None)"과 "명시적 null(Some(None))"을 구분하기 위한 역직렬화 헬퍼
pub fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

pub trait HasMeta {
    fn id(&self) -> &str;
    fn project_id(&self) -> Option<&str> {
        None
    }
}

// ---------------------------------------------------------------- User & Auth

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: Option<String>,
    #[serde(default)]
    pub last_login_at: Option<DateTime<Utc>>,
}

impl HasMeta for User {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Deserialize)]
pub struct GoogleLoginRequest {
    pub credential: String,
}

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub user: User,
}

// ---------------------------------------------------------------- Member & Permissions

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    View,
    Create,
    Edit,
    Delete,
    Admin,
}

impl Permission {
    pub const ALL: [Permission; 5] = [
        Permission::View,
        Permission::Create,
        Permission::Edit,
        Permission::Delete,
        Permission::Admin,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::View => "view",
            Permission::Create => "create",
            Permission::Edit => "edit",
            Permission::Delete => "delete",
            Permission::Admin => "admin",
        }
    }
}

pub fn normalize_permissions(perms: &[Permission]) -> Vec<Permission> {
    let has_admin = perms.contains(&Permission::Admin);
    if has_admin {
        return Permission::ALL.to_vec();
    }
    let mut out = Vec::with_capacity(5);
    for p in Permission::ALL {
        if p == Permission::View || perms.contains(&p) {
            out.push(p);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMember {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub email: String,
    pub permissions: Vec<Permission>,
    pub added_by: String,
}

impl HasMeta for ProjectMember {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct MemberCreate {
    pub email: String,
    #[serde(default = "default_member_perms")]
    pub permissions: Vec<Permission>,
    #[serde(default = "default_true")]
    pub send_invite: bool,
}

fn default_member_perms() -> Vec<Permission> {
    vec![Permission::View, Permission::Create, Permission::Edit]
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct MemberUpdate {
    pub permissions: Vec<Permission>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberRead {
    pub id: String,
    pub email: String,
    pub user: Option<User>,
    pub permissions: Vec<Permission>,
    pub is_owner: bool,
    pub pending: bool,
    pub invite_status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OwnershipTransferRequest {
    pub new_owner_user_id: String,
}

// ---------------------------------------------------------------- Project

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub key: String,
    pub created_by: String,
    #[serde(default)]
    pub task_seq: i64,
}

impl HasMeta for Project {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.id)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectRead {
    #[serde(flatten)]
    pub project: Project,
    pub my_permissions: Vec<Permission>,
    pub is_owner: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProjectCreate {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct ProjectUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
}

// ---------------------------------------------------------------- Tasks & Pipeline

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineStage {
    Backlog,
    Todo,
    InProgress,
    Review,
    Qa,
    Done,
}

impl PipelineStage {
    pub const ALL: [PipelineStage; 6] = [
        PipelineStage::Backlog,
        PipelineStage::Todo,
        PipelineStage::InProgress,
        PipelineStage::Review,
        PipelineStage::Qa,
        PipelineStage::Done,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            PipelineStage::Backlog => "백로그",
            PipelineStage::Todo => "할 일",
            PipelineStage::InProgress => "진행 중",
            PipelineStage::Review => "코드 리뷰",
            PipelineStage::Qa => "QA",
            PipelineStage::Done => "완료",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            PipelineStage::Backlog => "backlog",
            PipelineStage::Todo => "todo",
            PipelineStage::InProgress => "in_progress",
            PipelineStage::Review => "review",
            PipelineStage::Qa => "qa",
            PipelineStage::Done => "done",
        }
    }
}

impl Default for PipelineStage {
    fn default() -> Self {
        PipelineStage::Backlog
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Medium,
    High,
    Urgent,
}

impl Priority {
    pub fn rank(&self) -> u8 {
        match self {
            Priority::Urgent => 0,
            Priority::High => 1,
            Priority::Medium => 2,
            Priority::Low => 3,
        }
    }
}

impl Default for Priority {
    fn default() -> Self {
        Priority::Medium
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChecklistItem {
    #[serde(default = "new_id")]
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskLinkKind {
    Blocks,
    RelatesTo,
    Duplicates,
}

impl TaskLinkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskLinkKind::Blocks => "blocks",
            TaskLinkKind::RelatesTo => "relates_to",
            TaskLinkKind::Duplicates => "duplicates",
        }
    }

    pub fn reverse_str(&self) -> &'static str {
        match self {
            TaskLinkKind::Blocks => "blocked_by",
            TaskLinkKind::RelatesTo => "relates_to",
            TaskLinkKind::Duplicates => "duplicated_by",
        }
    }
}

impl Default for TaskLinkKind {
    fn default() -> Self {
        TaskLinkKind::RelatesTo
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLink {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub source_id: String,
    pub target_id: String,
    pub kind: TaskLinkKind,
    pub created_by: String,
}

impl HasMeta for TaskLink {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct TaskLinkCreate {
    pub target_id: String,
    #[serde(default)]
    pub kind: TaskLinkKind,
}

#[derive(Debug, Serialize)]
pub struct TaskLinkRead {
    pub id: String,
    pub kind: String,
    pub task_id: String,
    pub number: i64,
    pub title: String,
    pub stage: PipelineStage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub stage: PipelineStage,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub cycle_id: Option<String>,
    #[serde(default)]
    pub milestone_id: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub due_date: Option<NaiveDate>,
    #[serde(default)]
    pub estimate: Option<i64>,
    #[serde(default)]
    pub checklist: Vec<ChecklistItem>,
    #[serde(default)]
    pub triage_status: Option<String>,
    #[serde(default)]
    pub triage_snooze_until: Option<NaiveDate>,
    #[serde(default)]
    pub triage_source: String,
    pub project_id: String,
    pub number: i64,
    pub created_by: String,
    #[serde(default)]
    pub watcher_ids: Vec<String>,
    #[serde(default)]
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub deleted_by: Option<String>,
    #[serde(default)]
    pub via_client: Option<String>,
}

impl HasMeta for Task {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskRead {
    #[serde(flatten)]
    pub task: Task,
    pub comment_count: usize,
    pub subtask_count: usize,
    pub subtask_done: usize,
    pub blocked_by_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MyTaskRead {
    #[serde(flatten)]
    pub base: TaskRead,
    pub project_key: String,
    pub project_name: String,
}

#[derive(Debug, Deserialize)]
pub struct TaskCreate {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub stage: PipelineStage,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub cycle_id: Option<String>,
    #[serde(default)]
    pub milestone_id: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub due_date: Option<NaiveDate>,
    #[serde(default)]
    pub estimate: Option<i64>,
    #[serde(default)]
    pub checklist: Vec<ChecklistItem>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TaskUpdate {
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub stage: Option<Option<PipelineStage>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub priority: Option<Option<Priority>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub cycle_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub milestone_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub version: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub assignee_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub start_date: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub due_date: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub estimate: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub checklist: Option<Option<Vec<ChecklistItem>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineStageInfo {
    pub key: PipelineStage,
    pub label: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub wip_limit: Option<i64>,
}

pub fn default_pipeline_stages() -> Vec<PipelineStageInfo> {
    PipelineStage::ALL
        .iter()
        .map(|&s| PipelineStageInfo {
            key: s,
            label: s.label().into(),
            color: String::new(),
            hidden: false,
            wip_limit: None,
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectPipeline {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub stages: Vec<PipelineStageInfo>,
}

impl HasMeta for ProjectPipeline {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectPipelineUpdate {
    pub stages: Vec<PipelineStageInfo>,
    #[serde(default)]
    pub remap_hidden_to: Option<PipelineStage>,
}

// ---------------------------------------------------------------- Comments & Reactions & Activity

pub const ALLOWED_REACTIONS: &[&str] = &["👍", "👀", "✅", "❤️", "🚀"];

pub fn toggle_reaction_map(
    reactions: &HashMap<String, Vec<String>>,
    emoji: &str,
    user_id: &str,
) -> HashMap<String, Vec<String>> {
    let mut next = reactions.clone();
    let entry = next.entry(emoji.to_string()).or_default();
    if let Some(pos) = entry.iter().position(|u| u == user_id) {
        entry.remove(pos);
        if entry.is_empty() {
            next.remove(emoji);
        }
    } else {
        entry.push(user_id.to_string());
    }
    next
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub task_id: String,
    pub author_id: String,
    pub body: String,
    #[serde(default)]
    pub reactions: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub via_client: Option<String>,
}

impl HasMeta for Comment {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct CommentBody {
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct ReactionToggle {
    pub emoji: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskActivity {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub task_id: String,
    pub actor_id: String,
    pub kind: String, // "created" | "updated"
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub old: Value,
    #[serde(default)]
    pub new: Value,
    #[serde(default)]
    pub via_client: Option<String>,
}

impl HasMeta for TaskActivity {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

// ---------------------------------------------------------------- Wiki

pub fn clean_string_list(values: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in values {
        let cleaned = v.split_whitespace().collect::<Vec<_>>().join(" ");
        let key = cleaned.to_lowercase();
        if !cleaned.is_empty() && seen.insert(key) {
            let truncated: String = cleaned.chars().take(100).collect();
            out.push(truncated);
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageType {
    Guide,
    Spec,
    Decision,
    Meeting,
    Reference,
    Note,
}

impl PageType {
    pub fn as_str(&self) -> &'static str {
        match self {
            PageType::Guide => "guide",
            PageType::Spec => "spec",
            PageType::Decision => "decision",
            PageType::Meeting => "meeting",
            PageType::Reference => "reference",
            PageType::Note => "note",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageStatus {
    Draft,
    Review,
    Published,
    Deprecated,
}

impl PageStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            PageStatus::Draft => "draft",
            PageStatus::Review => "review",
            PageStatus::Published => "published",
            PageStatus::Deprecated => "deprecated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiPage {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub page_type: Option<PageType>,
    #[serde(default)]
    pub status: Option<PageStatus>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub project_id: String,
    pub created_by: String,
    pub updated_by: String,
    #[serde(default)]
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub deleted_by: Option<String>,
}

impl HasMeta for WikiPage {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct WikiPageCreate {
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub page_type: Option<PageType>,
    #[serde(default)]
    pub status: Option<PageStatus>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct WikiPageUpdate {
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub content: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub aliases: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub page_type: Option<Option<PageType>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub status: Option<Option<PageStatus>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub owner_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(default)]
    pub expected_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WikiPageSummary {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub aliases: Vec<String>,
    pub page_type: Option<PageType>,
    pub status: Option<PageStatus>,
    pub owner_id: Option<String>,
    pub tags: Vec<String>,
    pub backlink_count: usize,
    pub broken_link_count: usize,
    pub updated_at: DateTime<Utc>,
}

impl WikiPageSummary {
    pub fn from_page(p: &WikiPage, backlink_count: usize, broken_link_count: usize) -> Self {
        Self {
            id: p.id.clone(),
            title: p.title.clone(),
            parent_id: p.parent_id.clone(),
            aliases: p.aliases.clone(),
            page_type: p.page_type,
            status: p.status,
            owner_id: p.owner_id.clone(),
            tags: p.tags.clone(),
            backlink_count,
            broken_link_count,
            updated_at: p.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiComment {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub page_id: String,
    pub author_id: String,
    pub body: String,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub resolved_by: Option<String>,
    #[serde(default)]
    pub reactions: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub via_client: Option<String>,
}

impl HasMeta for WikiComment {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct WikiCommentUpdate {
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub resolved: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiRevision {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub page_id: String,
    pub version: i64,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub page_type: Option<PageType>,
    #[serde(default)]
    pub status: Option<PageStatus>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub editor_id: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub via_client: Option<String>,
}

impl HasMeta for WikiRevision {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Serialize)]
pub struct WikiRevisionSummary {
    pub id: String,
    pub page_id: String,
    pub version: i64,
    pub title: String,
    pub editor_id: String,
    pub note: String,
    pub via_client: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    pub kind: &'static str, // "equal" | "add" | "del"
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct WikiRevisionDetail {
    #[serde(flatten)]
    pub rev: WikiRevision,
    pub diff_to_current: Vec<DiffLine>,
}

// ---------------------------------------------------------------- Notifications & Audit

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub user_id: String,
    pub project_id: String,
    pub actor_id: String,
    pub kind: String, // mention | assigned | comment | ownership | invite | watched
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub read: bool,
}

impl HasMeta for Notification {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLog {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub actor_id: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub summary: String,
    #[serde(default)]
    pub details: HashMap<String, Value>,
}

impl HasMeta for AuditLog {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

// ---------------------------------------------------------------- Generic JSON-backed collections (Phase 2/3 typed later)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenericEntity {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl HasMeta for GenericEntity {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        self.project_id.as_deref()
    }
}

pub fn clean_version(v: Option<String>) -> Option<String> {
    v.and_then(|s| {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}
