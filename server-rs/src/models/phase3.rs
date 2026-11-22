use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::models::HasMeta;

// ---------------------------------------------------------------- GitHub Integration

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIntegration {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub webhook_secret: String,
    #[serde(default = "default_true")]
    pub auto_transition: bool,
}

impl HasMeta for GitHubIntegration {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct GitHubIntegrationUpdate {
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default)]
    pub rotate_secret: bool,
    #[serde(default = "default_true")]
    pub auto_transition: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitHubIntegrationRead {
    pub repo: String,
    pub has_secret: bool,
    pub auto_transition: bool,
    pub webhook_url: String,
    pub generated_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLink {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub task_id: String,
    pub kind: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub title: String,
    pub url: String,
    pub state: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub branch: String,
}

// Note: Python serializes field name "ref", so use serde rename on `GitHubLink`:
// Let's keep field named `ref_` with `#[serde(rename = "ref")]`!
impl HasMeta for GitHubLink {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

// ---------------------------------------------------------------- Project Webhooks

pub const WEBHOOK_EVENTS: &[&str] = &[
    "task.created",
    "task.stage_changed",
    "task.updated",
    "comment.created",
    "mention",
    "due_soon",
];

fn default_preset() -> String {
    "custom".into()
}

fn default_webhook_events() -> Vec<String> {
    WEBHOOK_EVENTS.iter().map(|s| s.to_string()).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWebhook {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub name: String,
    pub url: String,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "default_webhook_events")]
    pub events: Vec<String>,
    #[serde(default)]
    pub trigger_tags: Vec<String>,
    #[serde(default)]
    pub trigger_stages: Vec<String>,
    #[serde(default)]
    pub secret: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_by: String,
}

impl HasMeta for ProjectWebhook {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectWebhookCreate {
    pub name: String,
    pub url: String,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "default_webhook_events")]
    pub events: Vec<String>,
    #[serde(default)]
    pub trigger_tags: Vec<String>,
    #[serde(default)]
    pub trigger_stages: Vec<String>,
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProjectWebhookUpdate {
    pub name: Option<String>,
    pub url: Option<String>,
    pub preset: Option<String>,
    pub events: Option<Vec<String>>,
    pub trigger_tags: Option<Vec<String>>,
    pub trigger_stages: Option<Vec<String>>,
    pub secret: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectWebhookRead {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub url: String,
    pub preset: String,
    pub events: Vec<String>,
    pub trigger_tags: Vec<String>,
    pub trigger_stages: Vec<String>,
    pub has_secret: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub generated_secret: Option<String>,
}

fn default_one() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookDelivery {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub webhook_id: String,
    pub event: String,
    #[serde(default)]
    pub status_code: Option<i64>,
    #[serde(default)]
    pub ok: bool,
    #[serde(default = "default_one")]
    pub attempts: i64,
    #[serde(default)]
    pub error: String,
}

impl HasMeta for WebhookDelivery {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

// ---------------------------------------------------------------- OAuth 2.1

pub const SCOPE_READ: &str = "mightywork:read";
pub const SCOPE_WRITE: &str = "mightywork:write";
pub const OAUTH_SCOPES: &[&str] = &[SCOPE_READ, SCOPE_WRITE];

pub fn scope_labels() -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    m.insert(SCOPE_READ.into(), "프로젝트·일감·위키 읽기".into());
    m.insert(SCOPE_WRITE.into(), "일감·위키 만들기와 고치기, 덧글 쓰기".into());
    m
}

fn default_none_auth() -> String {
    "none".into()
}

fn default_native() -> String {
    "native".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthClient {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub client_id: String,
    #[serde(default)]
    pub client_secret_hash: Option<String>,
    pub client_name: String,
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    #[serde(default = "default_none_auth")]
    pub token_endpoint_auth_method: String,
    #[serde(default = "default_native")]
    pub application_type: String,
}

impl HasMeta for OAuthClient {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthGrant {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub user_id: String,
    pub client_id: String,
    pub client_name: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub last_used_at: Option<DateTime<Utc>>,
}

impl HasMeta for OAuthGrant {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshToken {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub token_hash: String,
    pub grant_id: String,
    pub user_id: String,
    pub client_id: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub resource: String,
    pub expires_at: DateTime<Utc>,
    #[serde(default)]
    pub used: bool,
}

impl HasMeta for RefreshToken {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GrantRead {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub scopes: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}
