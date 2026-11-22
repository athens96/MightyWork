// 서버 app/models/* 와 1:1 대응

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface Project {
  id: string;
  key: string; // 일감 번호 접두어 (MW → MW-1)
  name: string;
  description: string;
  created_by: string;
  task_seq: number;
  my_permissions: Permission[]; // 내 권한 (응답 전용)
  is_owner: boolean; // 내가 만든 프로젝트인지
  created_at: string;
  updated_at: string;
}

/** 보기 / 생성 / 편집 / 삭제 / 관리자 */
export type Permission = "view" | "create" | "edit" | "delete" | "admin";

export interface Member {
  id: string; // 소유자는 "owner"
  email: string;
  user: User | null; // 아직 로그인한 적 없으면 null
  permissions: Permission[];
  is_owner: boolean;
  pending: boolean; // 초대됐지만 로그인 전
  invite_status?: string | null; // sent | skipped_unconfigured | failed
}

export type ProjectCreate = Pick<Project, "key" | "name"> & Partial<Pick<Project, "description">>;
export type ProjectUpdate = Partial<Pick<Project, "name" | "description">>;

export type PipelineStage = "backlog" | "todo" | "in_progress" | "review" | "qa" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface SavedView {
  id: string;
  project_id: string;
  name: string;
  layout: "board" | "list" | "timeline";
  filters: Record<string, string>;
  created_by: string;
  created_at: string;
}

export type CycleStatus = "upcoming" | "active" | "completed";

export interface CycleBurndownPoint {
  day: string;
  ideal: number;
  remaining: number | null;
}

export interface Cycle {
  id: string;
  project_id: string;
  name: string;
  goal: string;
  start_date: string;
  end_date: string;
  target_points: number | null;
  status: CycleStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  total_tasks: number;
  done_tasks: number;
  total_points: number;
  done_points: number;
  completion_pct: number;
  burndown: CycleBurndownPoint[];
}

export interface CycleCreate {
  name: string;
  goal?: string;
  start_date: string;
  end_date: string;
  target_points?: number | null;
  status?: CycleStatus;
}

export type CycleUpdate = Partial<CycleCreate>;

export interface CycleCompleteResult {
  completed: Cycle;
  next_cycle: Cycle | null;
  rolled_over_count: number;
}

export type MilestoneStatus = "planned" | "active" | "completed";

export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  description: string;
  start_date: string | null;
  target_date: string | null;
  status: MilestoneStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  total_tasks: number;
  done_tasks: number;
  in_progress_tasks: number;
  total_points: number;
  done_points: number;
  progress_pct: number;
}

export interface MilestoneCreate {
  name: string;
  description?: string;
  start_date?: string | null;
  target_date?: string | null;
  status?: MilestoneStatus;
}

export type MilestoneUpdate = Partial<MilestoneCreate>;

export type ReleaseStatus = "released" | "in_progress" | "planned";

export interface ReleaseTaskItem {
  id: string;
  number: number;
  key: string;
  title: string;
  stage: PipelineStage;
  priority: Priority;
  tags: string[];
  estimate: number | null;
  assignee_id: string | null;
  updated_at: string;
}

export interface ReleaseSummary {
  version: string;
  status: ReleaseStatus;
  total_tasks: number;
  done_tasks: number;
  in_progress_tasks: number;
  todo_tasks: number;
  total_points: number;
  done_points: number;
  progress_pct: number;
  latest_updated_at: string | null;
  tasks: ReleaseTaskItem[];
}

export interface ReleaseListResponse {
  releases: ReleaseSummary[];
  unversioned_count: number;
}

export interface ReleaseChangelogResponse {
  version: string;
  markdown: string;
  total_tasks: number;
  done_tasks: number;
  included_tasks: number;
}

export interface TaskTemplate {
  id: string;
  project_id: string;
  name: string;
  title_prefix: string;
  description: string;
  stage: PipelineStage;
  priority: Priority;
  tags: string[];
  checklist: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskTemplateCreate {
  name: string;
  title_prefix?: string;
  description?: string;
  stage?: PipelineStage;
  priority?: Priority;
  tags?: string[];
  checklist?: string[];
}

export interface TaskBulkRequest {
  task_ids: string[];
  stage?: PipelineStage;
  priority?: Priority;
  assignee_id?: string | null;
  cycle_id?: string | null;
  milestone_id?: string | null;
  version?: string | null;
  add_tags?: string[];
  remove_tags?: string[];
  delete?: boolean;
}

export interface TaskBulkResult {
  affected: number;
  tasks: Task[];
}

export interface PipelineStageInfo {
  key: PipelineStage;
  label: string;
  color?: string;
  hidden?: boolean;
  wip_limit?: number | null;
}

export interface ChecklistItem {
  id?: string; // 새 항목은 서버가 발급
  text: string;
  done: boolean;
}

export type TaskLinkKind = "blocks" | "relates_to" | "duplicates";

export interface TaskLink {
  id: string;
  kind: "blocks" | "blocked_by" | "relates_to" | "duplicates" | "duplicated_by";
  task_id: string;
  number: number;
  title: string;
  stage: PipelineStage;
}

export interface Task {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string; // Markdown
  stage: PipelineStage;
  priority: Priority;
  parent_id: string | null;
  cycle_id: string | null;
  milestone_id: string | null;
  version: string | null; // 목표/릴리즈 버전 (예: v0.5.10, v0.6.x)
  assignee_id: string | null; // 작업자
  tags: string[]; // 레이블
  start_date: string | null; // YYYY-MM-DD
  due_date: string | null;
  estimate: number | null; // 스토리 포인트
  checklist: ChecklistItem[]; // 할 일
  triage_status?: "pending" | "snoozed" | "declined" | null;
  triage_snooze_until?: string | null;
  triage_source?: string;
  comment_count: number; // 응답 전용
  subtask_count: number;
  subtask_done: number;
  created_by: string; // 보고자
  via_client?: string | null; // MCP AI 에이전트 출처
  created_at: string;
  updated_at: string;
}

export interface MyTask extends Task {
  project_key: string;
  project_name: string;
}

type TaskServerFields = "id" | "project_id" | "number" | "created_by" | "created_at" | "updated_at" | "comment_count" | "subtask_count" | "subtask_done";
export type TaskCreate = Pick<Task, "title"> & Partial<Omit<Task, TaskServerFields>>;
export type TaskUpdate = Partial<Omit<Task, TaskServerFields>>;

export interface WikiPage {
  id: string;
  title: string;
  content: string;
  parent_id: string | null;
  aliases: string[]; // 별칭(동의어)
  page_type: PageType | null; // Properties
  status: PageStatus | null;
  owner_id: string | null; // 문서 담당자
  tags: string[];
  project_id: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface WikiPageSummary {
  id: string;
  title: string;
  parent_id: string | null;
  aliases: string[];
  page_type: PageType | null;
  status: PageStatus | null;
  owner_id: string | null;
  tags: string[];
  updated_at: string;
}

export type WikiPageCreate = Pick<WikiPage, "title"> &
  Partial<Pick<WikiPage, "content" | "parent_id" | "page_type" | "status" | "tags" | "aliases">>;
export type WikiPageUpdate = Partial<
  Pick<WikiPage, "title" | "content" | "parent_id" | "aliases" | "page_type" | "status" | "owner_id" | "tags">
> & { expected_updated_at?: string };

export interface WikiComment {
  id: string;
  project_id: string;
  page_id: string;
  author_id: string;
  body: string;
  resolved: boolean;
  resolved_by: string | null;
  via_client?: string | null;
  created_at: string;
  updated_at: string;
}

export type PageType = "guide" | "spec" | "decision" | "meeting" | "reference" | "note";
export type PageStatus = "draft" | "review" | "published" | "deprecated";

export interface TaskRef {
  id: string;
  number: number;
  title: string;
  stage: PipelineStage;
}

export interface PageLinks {
  outgoing: { title: string; page_id: string | null }[]; // 이 문서가 링크한 문서 (없는 페이지는 null)
  backlinks: WikiPageSummary[]; // 이 문서를 링크한 문서
  tasks: TaskRef[]; // 이 문서가 언급한 일감
  missing_tasks: number[];
}

export interface SearchHit {
  kind: "task" | "wiki";
  id: string;
  title: string;
  snippet: string;
  score: number;
  number: number | null;
  stage: PipelineStage | null;
}

export interface UnlinkedMention {
  source_type: "wiki" | "task";
  source_id: string;
  title: string;
  number: number | null;
  count: number;
  snippets: string[];
}

export interface GraphNode {
  id: string; // "wiki:<id>" | "task:<id>" | "glossary:<id>" | "entity:<id>"
  kind: "wiki" | "task" | "glossary" | "entity";
  ref_id: string;
  label: string;
  depth: number; // 중심 0
  status: string | null; // 위키 상태, 일감 단계, 엔티티 종류
  number: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "link" | "mention" | "parent" | "task_link" | "broader" | "relation";
  label?: string | null;
}

export interface LocalGraph {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface Comment {
  id: string;
  project_id: string;
  task_id: string;
  author_id: string;
  body: string; // Markdown
  via_client?: string | null;
  created_at: string;
  updated_at: string;
}

export type TrackedField = "title" | "stage" | "priority" | "parent_id" | "cycle_id" | "milestone_id" | "version" | "assignee_id" | "start_date" | "due_date" | "estimate" | "tags";

export interface TaskActivity {
  id: string;
  task_id: string;
  actor_id: string;
  kind: "created" | "updated";
  field: TrackedField | null;
  old: unknown;
  new: unknown;
  via_client?: string | null;
  created_at: string;
}

export interface ConsentRequest {
  client_id: string;
  client_name: string;
  registration: "cimd" | "dcr";
  redirect_host: string;
  requested_scopes: string[];
  scope_labels: Record<string, string>;
}

export interface OAuthGrant {
  id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

export interface McpInfo {
  url: string;
  issuer: string;
  scopes: string[];
}

export interface Attachment {
  id: string;
  project_id: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  task_id: string | null;
  wiki_page_id: string | null;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface WikiRevisionSummary {
  id: string;
  page_id: string;
  version: number;
  title: string;
  editor_id: string;
  note: string;
  via_client?: string | null;
  created_at: string;
}

export interface DiffLine {
  kind: "equal" | "add" | "del";
  text: string;
}

export interface WikiRevisionDetail extends WikiRevisionSummary {
  content: string;
  aliases: string[];
  page_type: PageType | null;
  status: PageStatus | null;
  tags: string[];
  diff_to_current: DiffLine[];
}

export interface NotificationItem {
  id: string;
  user_id: string;
  project_id: string;
  actor_id: string;
  kind: "mention" | "assigned" | "comment" | "ownership" | "invite";
  title: string;
  body: string;
  link: string;
  read: boolean;
  created_at: string;
}

export interface NotificationList {
  unread_count: number;
  items: NotificationItem[];
}

export interface AuditLog {
  id: string;
  project_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  summary: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface GlossaryTerm {
  id: string;
  project_id: string;
  term: string;
  definition: string;
  synonyms: string[];
  broader_id: string | null;
  wiki_page_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface GlossaryUsage {
  source_type: "wiki" | "task";
  source_id: string;
  title: string;
  number: number | null;
  count: number;
  snippets: string[];
}

export type EntityKind = "system" | "service" | "api" | "data" | "role" | "decision" | "concept";
export type RelationKind = "uses" | "depends_on" | "produces" | "owns" | "implements" | "decides" | "relates_to";
export type ReviewStatus = "pending" | "approved" | "rejected";

export interface SourceRef {
  source_type: "wiki" | "task" | "glossary";
  source_id: string;
  title: string;
  excerpt: string;
}

export interface KnowledgeEntity {
  id: string;
  project_id: string;
  name: string;
  kind: EntityKind;
  description: string;
  aliases: string[];
  status: ReviewStatus;
  confidence: number;
  sources: SourceRef[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface KnowledgeRelation {
  id: string;
  project_id: string;
  source_entity_id: string;
  target_entity_id: string;
  kind: RelationKind;
  evidence: string;
  source_ref: SourceRef | null;
  status: ReviewStatus;
  confidence: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface ExtractResult {
  entities_added: number;
  relations_added: number;
  pending_entities: number;
  pending_relations: number;
}

export interface QACitation {
  kind: "wiki" | "task" | "glossary" | "entity";
  id: string;
  title: string;
  snippet: string;
  number: number | null;
  link: string;
}

export interface QAResponse {
  question: string;
  answer: string;
  expanded_terms: string[];
  citations: QACitation[];
  related_facts: string[];
  graph_nodes: GraphNode[];
  graph_edges: GraphEdge[];
}

export interface GitHubConfig {
  repo: string;
  has_secret: boolean;
  auto_transition: boolean;
  webhook_url: string;
  generated_secret?: string | null;
}

export interface GitHubLink {
  id: string;
  project_id: string;
  task_id: string;
  kind: "pr" | "commit";
  ref: string;
  title: string;
  url: string;
  state: string;
  author: string;
  branch: string;
  updated_at: string;
}

export type WebhookPreset = "custom" | "slack" | "discord";

export interface ProjectWebhook {
  id: string;
  project_id: string;
  name: string;
  url: string;
  preset: WebhookPreset;
  events: string[];
  trigger_tags?: string[];
  trigger_stages?: string[];
  has_secret: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  generated_secret?: string | null;
}

export interface WebhookDelivery {
  id: string;
  project_id: string;
  webhook_id: string;
  event: string;
  status_code: number | null;
  ok: boolean;
  attempts: number;
  error: string;
  created_at: string;
}

export interface IntakeConfig {
  enabled: boolean;
  token: string;
  intake_url: string;
}
