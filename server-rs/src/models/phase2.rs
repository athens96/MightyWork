use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{deserialize_double_option, HasMeta, PipelineStage, Priority};

// ---------------------------------------------------------------- Glossary

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlossaryTerm {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub term: String,
    #[serde(default)]
    pub definition: String,
    #[serde(default)]
    pub synonyms: Vec<String>,
    #[serde(default)]
    pub broader_id: Option<String>,
    #[serde(default)]
    pub wiki_page_id: Option<String>,
    pub created_by: String,
    pub updated_by: String,
}

impl HasMeta for GlossaryTerm {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct GlossaryTermCreate {
    pub term: String,
    #[serde(default)]
    pub definition: String,
    #[serde(default)]
    pub synonyms: Vec<String>,
    #[serde(default)]
    pub broader_id: Option<String>,
    #[serde(default)]
    pub wiki_page_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GlossaryTermUpdate {
    pub term: Option<String>,
    pub definition: Option<String>,
    pub synonyms: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub broader_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub wiki_page_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlossaryUsage {
    pub source_type: &'static str,
    pub source_id: String,
    pub title: String,
    pub number: Option<i64>,
    pub count: usize,
    pub snippets: Vec<String>,
}

// ---------------------------------------------------------------- Knowledge Entities & Relations

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    System,
    Service,
    Api,
    Data,
    Role,
    Decision,
    Concept,
}

impl EntityKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntityKind::System => "system",
            EntityKind::Service => "service",
            EntityKind::Api => "api",
            EntityKind::Data => "data",
            EntityKind::Role => "role",
            EntityKind::Decision => "decision",
            EntityKind::Concept => "concept",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Uses,
    DependsOn,
    Produces,
    Owns,
    Implements,
    Decides,
    RelatesTo,
}

impl RelationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RelationKind::Uses => "uses",
            RelationKind::DependsOn => "depends_on",
            RelationKind::Produces => "produces",
            RelationKind::Owns => "owns",
            RelationKind::Implements => "implements",
            RelationKind::Decides => "decides",
            RelationKind::RelatesTo => "relates_to",
        }
    }

    pub fn ko_label(&self) -> &'static str {
        match self {
            RelationKind::Uses => "사용함",
            RelationKind::DependsOn => "의존함",
            RelationKind::Produces => "생성함",
            RelationKind::Owns => "담당함",
            RelationKind::Implements => "구현함",
            RelationKind::Decides => "결정함",
            RelationKind::RelatesTo => "관련됨",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub source_type: String,
    pub source_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub excerpt: String,
}

fn default_pending() -> String {
    "pending".into()
}
fn default_approved() -> String {
    "approved".into()
}
fn default_conf_entity() -> f64 {
    0.7
}
fn default_conf_rel() -> f64 {
    0.65
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntity {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub name: String,
    pub kind: EntityKind,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_pending")]
    pub status: String,
    #[serde(default = "default_conf_entity")]
    pub confidence: f64,
    #[serde(default)]
    pub sources: Vec<SourceRef>,
    #[serde(default)]
    pub reviewed_by: Option<String>,
    #[serde(default)]
    pub reviewed_at: Option<DateTime<Utc>>,
}

impl HasMeta for KnowledgeEntity {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct KnowledgeEntityCreate {
    pub name: String,
    pub kind: EntityKind,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_approved")]
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct KnowledgeEntityUpdate {
    pub name: Option<String>,
    pub kind: Option<EntityKind>,
    pub description: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeRelation {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub kind: RelationKind,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub source_ref: Option<SourceRef>,
    #[serde(default = "default_pending")]
    pub status: String,
    #[serde(default = "default_conf_rel")]
    pub confidence: f64,
    #[serde(default)]
    pub reviewed_by: Option<String>,
    #[serde(default)]
    pub reviewed_at: Option<DateTime<Utc>>,
}

impl HasMeta for KnowledgeRelation {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct KnowledgeRelationCreate {
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub kind: RelationKind,
    #[serde(default)]
    pub evidence: String,
    #[serde(default = "default_approved")]
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct KnowledgeRelationUpdate {
    pub kind: Option<RelationKind>,
    pub evidence: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtractResult {
    pub entities_added: usize,
    pub relations_added: usize,
    pub pending_entities: usize,
    pub pending_relations: usize,
}

#[derive(Debug, Deserialize)]
pub struct QARequest {
    pub question: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QACitation {
    pub kind: &'static str,
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub number: Option<i64>,
    pub link: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QAResponse {
    pub question: String,
    pub answer: String,
    pub expanded_terms: Vec<String>,
    pub citations: Vec<QACitation>,
    pub related_facts: Vec<String>,
    pub graph_nodes: Vec<Value>,
    pub graph_edges: Vec<Value>,
}

// ---------------------------------------------------------------- Cycles

fn default_upcoming() -> String {
    "upcoming".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cycle {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub goal: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    #[serde(default)]
    pub target_points: Option<i64>,
    #[serde(default = "default_upcoming")]
    pub status: String,
    pub created_by: String,
}

impl HasMeta for Cycle {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct CycleCreate {
    pub name: String,
    #[serde(default)]
    pub goal: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    #[serde(default)]
    pub target_points: Option<i64>,
    #[serde(default = "default_upcoming")]
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct CycleUpdate {
    pub name: Option<String>,
    pub goal: Option<String>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub target_points: Option<Option<i64>>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CycleBurndownPoint {
    pub day: String,
    pub ideal: f64,
    pub remaining: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CycleRead {
    #[serde(flatten)]
    pub cycle: Cycle,
    pub total_tasks: usize,
    pub done_tasks: usize,
    pub total_points: i64,
    pub done_points: i64,
    pub completion_pct: i64,
    pub burndown: Vec<CycleBurndownPoint>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct CycleCompleteRequest {
    #[serde(default = "default_true")]
    pub rollover: bool,
    #[serde(default)]
    pub next_cycle_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CycleCompleteResult {
    pub completed: CycleRead,
    pub next_cycle: Option<CycleRead>,
    pub rolled_over_count: usize,
}

// ---------------------------------------------------------------- Milestones

fn default_planned() -> String {
    "planned".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub target_date: Option<NaiveDate>,
    #[serde(default = "default_planned")]
    pub status: String,
    pub created_by: String,
}

impl HasMeta for Milestone {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct MilestoneCreate {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub start_date: Option<NaiveDate>,
    #[serde(default)]
    pub target_date: Option<NaiveDate>,
    #[serde(default = "default_planned")]
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct MilestoneUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub start_date: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub target_date: Option<Option<NaiveDate>>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MilestoneRead {
    #[serde(flatten)]
    pub milestone: Milestone,
    pub total_tasks: usize,
    pub done_tasks: usize,
    pub in_progress_tasks: usize,
    pub total_points: i64,
    pub done_points: i64,
    pub progress_pct: i64,
}

// ---------------------------------------------------------------- Saved Views

fn default_board() -> String {
    "board".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedView {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub name: String,
    #[serde(default = "default_board")]
    pub layout: String,
    #[serde(default)]
    pub filters: HashMap<String, Value>,
    pub created_by: String,
}

impl HasMeta for SavedView {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct SavedViewCreate {
    pub name: String,
    #[serde(default = "default_board")]
    pub layout: String,
    #[serde(default)]
    pub filters: HashMap<String, Value>,
}

// ---------------------------------------------------------------- Task Templates

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTemplate {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub title_prefix: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub stage: PipelineStage,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub checklist: Vec<String>,
    pub created_by: String,
}

impl HasMeta for TaskTemplate {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct TaskTemplateCreate {
    pub name: String,
    #[serde(default)]
    pub title_prefix: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub stage: PipelineStage,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub checklist: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct TaskTemplateUpdate {
    pub name: Option<String>,
    pub title_prefix: Option<String>,
    pub description: Option<String>,
    pub stage: Option<PipelineStage>,
    pub priority: Option<Priority>,
    pub tags: Option<Vec<String>>,
    pub checklist: Option<Vec<String>>,
}

// ---------------------------------------------------------------- Attachments

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub filename: String,
    pub content_type: String,
    pub size: usize,
    pub uploaded_by: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub wiki_page_id: Option<String>,
}

impl HasMeta for Attachment {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentRead {
    #[serde(flatten)]
    pub attachment: Attachment,
    pub url: String,
}

// ---------------------------------------------------------------- Project Intake

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectIntake {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub project_id: String,
    pub token: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl HasMeta for ProjectIntake {
    fn id(&self) -> &str {
        &self.id
    }
    fn project_id(&self) -> Option<&str> {
        Some(&self.project_id)
    }
}
