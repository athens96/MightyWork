pub mod sqlite;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::db::sqlite::{SqliteEngine, SqliteRepo};
use crate::models::{
    AuditLog, Comment, GenericEntity, Notification, Project, ProjectMember, ProjectPipeline, Task,
    TaskActivity, TaskLink, User, WikiComment, WikiPage, WikiRevision,
};

pub const PROJECT_SCOPED_TABLES: &[&str] = &[
    "tasks",
    "task_links",
    "saved_views",
    "cycles",
    "milestones",
    "task_templates",
    "project_pipelines",
    "comments",
    "task_activities",
    "project_members",
    "wiki_pages",
    "wiki_revisions",
    "wiki_comments",
    "attachments",
    "notifications",
    "audit_logs",
    "glossary_terms",
    "knowledge_entities",
    "knowledge_relations",
    "github_integrations",
    "github_links",
    "project_webhooks",
    "webhook_deliveries",
    "project_intakes",
];

#[derive(Clone)]
pub struct Database {
    pub engine: Arc<SqliteEngine>,
    pub data_dir: PathBuf,
    pub users: SqliteRepo<User>,
    pub projects: SqliteRepo<Project>,
    pub project_members: SqliteRepo<ProjectMember>,
    pub tasks: SqliteRepo<Task>,
    pub task_links: SqliteRepo<TaskLink>,
    pub saved_views: SqliteRepo<GenericEntity>,
    pub cycles: SqliteRepo<GenericEntity>,
    pub milestones: SqliteRepo<GenericEntity>,
    pub task_templates: SqliteRepo<GenericEntity>,
    pub project_pipelines: SqliteRepo<ProjectPipeline>,
    pub comments: SqliteRepo<Comment>,
    pub task_activities: SqliteRepo<TaskActivity>,
    pub wiki_pages: SqliteRepo<WikiPage>,
    pub wiki_revisions: SqliteRepo<WikiRevision>,
    pub wiki_comments: SqliteRepo<WikiComment>,
    pub attachments: SqliteRepo<GenericEntity>,
    pub notifications: SqliteRepo<Notification>,
    pub audit_logs: SqliteRepo<AuditLog>,
    pub glossary_terms: SqliteRepo<GenericEntity>,
    pub knowledge_entities: SqliteRepo<GenericEntity>,
    pub knowledge_relations: SqliteRepo<GenericEntity>,
    pub github_integrations: SqliteRepo<GenericEntity>,
    pub github_links: SqliteRepo<GenericEntity>,
    pub project_webhooks: SqliteRepo<GenericEntity>,
    pub webhook_deliveries: SqliteRepo<GenericEntity>,
    pub project_intakes: SqliteRepo<GenericEntity>,
    pub oauth_clients: SqliteRepo<GenericEntity>,
    pub oauth_grants: SqliteRepo<GenericEntity>,
    pub refresh_tokens: SqliteRepo<GenericEntity>,
}

impl Database {
    pub fn open(data_dir: &Path) -> rusqlite::Result<Self> {
        let db_path = data_dir.join("mightywork.db");
        let engine = Arc::new(SqliteEngine::open(&db_path)?);
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            users: SqliteRepo::new(engine.clone(), "users")?,
            projects: SqliteRepo::new(engine.clone(), "projects")?,
            project_members: SqliteRepo::new(engine.clone(), "project_members")?,
            tasks: SqliteRepo::new(engine.clone(), "tasks")?,
            task_links: SqliteRepo::new(engine.clone(), "task_links")?,
            saved_views: SqliteRepo::new(engine.clone(), "saved_views")?,
            cycles: SqliteRepo::new(engine.clone(), "cycles")?,
            milestones: SqliteRepo::new(engine.clone(), "milestones")?,
            task_templates: SqliteRepo::new(engine.clone(), "task_templates")?,
            project_pipelines: SqliteRepo::new(engine.clone(), "project_pipelines")?,
            comments: SqliteRepo::new(engine.clone(), "comments")?,
            task_activities: SqliteRepo::new(engine.clone(), "task_activities")?,
            wiki_pages: SqliteRepo::new(engine.clone(), "wiki_pages")?,
            wiki_revisions: SqliteRepo::new(engine.clone(), "wiki_revisions")?,
            wiki_comments: SqliteRepo::new(engine.clone(), "wiki_comments")?,
            attachments: SqliteRepo::new(engine.clone(), "attachments")?,
            notifications: SqliteRepo::new(engine.clone(), "notifications")?,
            audit_logs: SqliteRepo::new(engine.clone(), "audit_logs")?,
            glossary_terms: SqliteRepo::new(engine.clone(), "glossary_terms")?,
            knowledge_entities: SqliteRepo::new(engine.clone(), "knowledge_entities")?,
            knowledge_relations: SqliteRepo::new(engine.clone(), "knowledge_relations")?,
            github_integrations: SqliteRepo::new(engine.clone(), "github_integrations")?,
            github_links: SqliteRepo::new(engine.clone(), "github_links")?,
            project_webhooks: SqliteRepo::new(engine.clone(), "project_webhooks")?,
            webhook_deliveries: SqliteRepo::new(engine.clone(), "webhook_deliveries")?,
            project_intakes: SqliteRepo::new(engine.clone(), "project_intakes")?,
            oauth_clients: SqliteRepo::new(engine.clone(), "oauth_clients")?,
            oauth_grants: SqliteRepo::new(engine.clone(), "oauth_grants")?,
            refresh_tokens: SqliteRepo::new(engine.clone(), "refresh_tokens")?,
            engine,
        })
    }

    pub fn allocate_task_number(&self, project_id: &str) -> rusqlite::Result<Option<i64>> {
        self.engine.allocate_task_number(project_id)
    }

    pub fn append_event(&self, channel: &str, kind: &str, payload: &Value) -> rusqlite::Result<i64> {
        self.engine.append_event(channel, kind, payload)
    }

    pub fn latest_event_seq(&self) -> rusqlite::Result<i64> {
        self.engine.latest_event_seq()
    }

    pub fn fetch_events(&self, channels: &[String], after_seq: i64, limit: i64) -> rusqlite::Result<Vec<(i64, String, Value)>> {
        self.engine.fetch_events(channels, after_seq, limit)
    }
}
