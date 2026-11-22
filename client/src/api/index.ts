import { http, requestFile, upload } from "./http";

export type ExportFormat = "md" | "html" | "docx" | "hwpx" | "hwp";
import type {
  Attachment,
  AuditLog,
  Comment,
  ConsentRequest,
  Cycle,
  CycleCompleteResult,
  CycleCreate,
  CycleUpdate,
  EntityKind,
  ExtractResult,
  GitHubConfig,
  GitHubLink,
  GlossaryTerm,
  GlossaryUsage,
  IntakeConfig,
  KnowledgeEntity,
  KnowledgeRelation,
  LocalGraph,
  McpInfo,
  Member,
  Milestone,
  MilestoneCreate,
  MilestoneUpdate,
  MyTask,
  NotificationItem,
  NotificationList,
  OAuthGrant,
  PageLinks,
  Permission,
  PipelineStage,
  PipelineStageInfo,
  Project,
  ProjectCreate,
  ProjectGraph,
  ProjectUpdate,
  ProjectWebhook,
  QAResponse,
  RelationKind,
  ReleaseChangelogResponse,
  ReleaseListResponse,
  ReviewStatus,
  SavedView,
  SearchHit,
  Task,
  TaskActivity,
  TaskBulkRequest,
  TaskBulkResult,
  TaskCreate,
  TaskLink,
  TaskLinkKind,
  TaskTemplate,
  TaskTemplateCreate,
  TaskUpdate,
  TokenResponse,
  UnlinkedMention,
  User,
  WebhookDelivery,
  WebhookPreset,
  WikiPage,
  WikiPageCreate,
  WikiPageSummary,
  WikiPageUpdate,
  WikiRevisionDetail,
  WikiRevisionSummary,
} from "../types";

export const authApi = {
  loginWithGoogle: (credential: string) => http.post<TokenResponse>("/auth/google", { credential }),
  refresh: () => http.post<TokenResponse>("/auth/refresh"),
  logout: () => http.post<void>("/auth/logout"),
  me: () => http.get<User>("/auth/me"),
};

export const usersApi = {
  list: () => http.get<User[]>("/users"),
  listByProject: (projectId: string) => http.get<User[]>(`/projects/${projectId}/users`),
};

export const attachmentsApi = {
  list: (projectId: string, params: { task_id?: string; wiki_page_id?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return http.get<Attachment[]>(`/projects/${projectId}/attachments${qs.size ? `?${qs}` : ""}`);
  },
  upload: (projectId: string, file: File, opts: { task_id?: string; wiki_page_id?: string } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (opts.task_id) form.append("task_id", opts.task_id);
    if (opts.wiki_page_id) form.append("wiki_page_id", opts.wiki_page_id);
    return upload<Attachment>(`/projects/${projectId}/attachments`, form);
  },
  download: (projectId: string, id: string) => requestFile(`/projects/${projectId}/attachments/${id}`),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/attachments/${id}`),
};

export const projectsApi = {
  list: () => http.get<Project[]>("/projects"),
  get: (id: string) => http.get<Project>(`/projects/${id}`),
  create: (body: ProjectCreate) => http.post<Project>("/projects", body),
  update: (id: string, body: ProjectUpdate) => http.patch<Project>(`/projects/${id}`, body),
  remove: (id: string) => http.delete(`/projects/${id}`),
  transferOwnership: (id: string, newOwnerUserId: string) =>
    http.post<Project>(`/projects/${id}/transfer-ownership`, { new_owner_user_id: newOwnerUserId }),
  auditLogs: (id: string, action?: string) => {
    const qs = action ? `?${new URLSearchParams({ action })}` : "";
    return http.get<AuditLog[]>(`/projects/${id}/audit-logs${qs}`);
  },
};

export const membersApi = {
  list: (projectId: string) => http.get<Member[]>(`/projects/${projectId}/members`),
  add: (projectId: string, email: string, permissions: Permission[], sendInvite = true) =>
    http.post<Member>(`/projects/${projectId}/members`, { email, permissions, send_invite: sendInvite }),
  resendInvite: (projectId: string, id: string) => http.post<Member>(`/projects/${projectId}/members/${id}/resend-invite`),
  update: (projectId: string, id: string, permissions: Permission[]) =>
    http.patch<Member>(`/projects/${projectId}/members/${id}`, { permissions }),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/members/${id}`),
};

export const notificationsApi = {
  list: (unreadOnly = false) => http.get<NotificationList>(`/notifications${unreadOnly ? "?unread_only=true" : ""}`),
  markRead: (id: string) => http.post<NotificationItem>(`/notifications/${id}/read`),
  markAllRead: () => http.post<{ updated: number }>("/notifications/read-all"),
};

export const pipelineApi = {
  get: () => http.get<PipelineStageInfo[]>("/pipeline"),
  forProject: (projectId: string) => http.get<PipelineStageInfo[]>(`/projects/${projectId}/pipeline`),
  save: (projectId: string, stages: PipelineStageInfo[], remapHiddenTo?: PipelineStage) =>
    http.put<PipelineStageInfo[]>(`/projects/${projectId}/pipeline`, { stages, remap_hidden_to: remapHiddenTo }),
};

export const viewsApi = {
  list: (projectId: string) => http.get<SavedView[]>(`/projects/${projectId}/views`),
  create: (projectId: string, body: { name: string; layout: SavedView["layout"]; filters: Record<string, string> }) =>
    http.post<SavedView>(`/projects/${projectId}/views`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/views/${id}`),
};

export const cyclesApi = {
  list: (projectId: string) => http.get<Cycle[]>(`/projects/${projectId}/cycles`),
  create: (projectId: string, body: CycleCreate) => http.post<Cycle>(`/projects/${projectId}/cycles`, body),
  update: (projectId: string, id: string, body: CycleUpdate) => http.patch<Cycle>(`/projects/${projectId}/cycles/${id}`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/cycles/${id}`),
  complete: (projectId: string, id: string, body: { rollover?: boolean; next_cycle_id?: string | null } = {}) =>
    http.post<CycleCompleteResult>(`/projects/${projectId}/cycles/${id}/complete`, body),
};

export const milestonesApi = {
  list: (projectId: string) => http.get<Milestone[]>(`/projects/${projectId}/milestones`),
  create: (projectId: string, body: MilestoneCreate) => http.post<Milestone>(`/projects/${projectId}/milestones`, body),
  update: (projectId: string, id: string, body: MilestoneUpdate) => http.patch<Milestone>(`/projects/${projectId}/milestones/${id}`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/milestones/${id}`),
};

export const releasesApi = {
  list: (projectId: string) => http.get<ReleaseListResponse>(`/projects/${projectId}/releases`),
  changelog: (projectId: string, version: string, includeUnfinished = false) =>
    http.get<ReleaseChangelogResponse>(
      `/projects/${projectId}/releases/${encodeURIComponent(version)}/changelog${includeUnfinished ? "?include_unfinished=true" : ""}`,
    ),
};

export const templatesApi = {
  list: (projectId: string) => http.get<TaskTemplate[]>(`/projects/${projectId}/task-templates`),
  create: (projectId: string, body: TaskTemplateCreate) => http.post<TaskTemplate>(`/projects/${projectId}/task-templates`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/task-templates/${id}`),
};

export const triageApi = {
  list: (projectId: string, includeDeclined = false) =>
    http.get<Task[]>(`/projects/${projectId}/triage${includeDeclined ? "?include_declined=true" : ""}`),
  create: (projectId: string, body: { title: string; description?: string; priority?: Task["priority"]; tags?: string[]; source?: string }) =>
    http.post<Task>(`/projects/${projectId}/triage`, body),
  decide: (
    projectId: string,
    taskId: string,
    body: { action: "accept" | "duplicate" | "snooze" | "decline"; target_stage?: PipelineStage; duplicate_of_id?: string; snooze_until?: string },
  ) => http.post<Task>(`/projects/${projectId}/triage/${taskId}/decide`, body),
  getIntake: (projectId: string) => http.get<IntakeConfig>(`/projects/${projectId}/intake`),
  saveIntake: (projectId: string, body: { enabled: boolean; rotate_token?: boolean }) =>
    http.put<IntakeConfig>(`/projects/${projectId}/intake`, body),
};

export const tasksApi = {
  my: (params: { scope?: "assigned" | "created" | "all"; due_soon?: boolean; include_done?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.scope) qs.set("scope", params.scope);
    if (params.due_soon) qs.set("due_soon", "true");
    if (params.include_done) qs.set("include_done", "true");
    return http.get<MyTask[]>(`/my/tasks${qs.size ? `?${qs}` : ""}`);
  },
  list: (projectId: string, params: { stage?: PipelineStage; assignee_id?: string; parent_id?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return http.get<Task[]>(`/projects/${projectId}/tasks${qs.size ? `?${qs}` : ""}`);
  },
  get: (projectId: string, id: string) => http.get<Task>(`/projects/${projectId}/tasks/${id}`),
  create: (projectId: string, body: TaskCreate) => http.post<Task>(`/projects/${projectId}/tasks`, body),
  update: (projectId: string, id: string, body: TaskUpdate) =>
    http.patch<Task>(`/projects/${projectId}/tasks/${id}`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/tasks/${id}`),
  bulk: (projectId: string, body: TaskBulkRequest) => http.post<TaskBulkResult>(`/projects/${projectId}/tasks/bulk`, body),
  subtasks: (projectId: string, id: string) => http.get<Task[]>(`/projects/${projectId}/tasks/${id}/subtasks`),
  links: (projectId: string, id: string) => http.get<TaskLink[]>(`/projects/${projectId}/tasks/${id}/links`),
  addLink: (projectId: string, id: string, targetId: string, kind: TaskLinkKind) =>
    http.post<TaskLink>(`/projects/${projectId}/tasks/${id}/links`, { target_id: targetId, kind }),
  removeLink: (projectId: string, id: string, linkId: string) =>
    http.delete(`/projects/${projectId}/tasks/${id}/links/${linkId}`),
  activity: (projectId: string, id: string) =>
    http.get<TaskActivity[]>(`/projects/${projectId}/tasks/${id}/activity`),
  wikiRefs: (projectId: string, id: string) => http.get<WikiPageSummary[]>(`/projects/${projectId}/tasks/${id}/wiki-refs`),
  wikiLinks: (projectId: string, id: string) =>
    http.get<{ title: string; page_id: string | null }[]>(`/projects/${projectId}/tasks/${id}/wiki-links`),
};

export const searchApi = {
  search: (projectId: string, q: string) =>
    http.get<SearchHit[]>(`/projects/${projectId}/search?${new URLSearchParams({ q })}`),
};

export const commentsApi = {
  list: (projectId: string, taskId: string) =>
    http.get<Comment[]>(`/projects/${projectId}/tasks/${taskId}/comments`),
  create: (projectId: string, taskId: string, body: string) =>
    http.post<Comment>(`/projects/${projectId}/tasks/${taskId}/comments`, { body }),
  update: (projectId: string, taskId: string, id: string, body: string) =>
    http.patch<Comment>(`/projects/${projectId}/tasks/${taskId}/comments/${id}`, { body }),
  remove: (projectId: string, taskId: string, id: string) =>
    http.delete(`/projects/${projectId}/tasks/${taskId}/comments/${id}`),
};

export const wikiApi = {
  list: (projectId: string) => http.get<WikiPageSummary[]>(`/projects/${projectId}/wiki/pages`),
  get: (projectId: string, id: string) => http.get<WikiPage>(`/projects/${projectId}/wiki/pages/${id}`),
  create: (projectId: string, body: WikiPageCreate) =>
    http.post<WikiPage>(`/projects/${projectId}/wiki/pages`, body),
  update: (projectId: string, id: string, body: WikiPageUpdate) =>
    http.patch<WikiPage>(`/projects/${projectId}/wiki/pages/${id}`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/wiki/pages/${id}`),
  revisions: (projectId: string, id: string) => http.get<WikiRevisionSummary[]>(`/projects/${projectId}/wiki/pages/${id}/revisions`),
  revision: (projectId: string, id: string, revId: string) =>
    http.get<WikiRevisionDetail>(`/projects/${projectId}/wiki/pages/${id}/revisions/${revId}`),
  restore: (projectId: string, id: string, revId: string) =>
    http.post<WikiPage>(`/projects/${projectId}/wiki/pages/${id}/revisions/${revId}/restore`),
  links: (projectId: string, id: string) => http.get<PageLinks>(`/projects/${projectId}/wiki/pages/${id}/links`),
  export: (projectId: string, id: string, opts: { format: ExportFormat; children?: boolean; preset?: string; print?: boolean }) => {
    const qs = new URLSearchParams({ format: opts.format });
    if (opts.children) qs.set("children", "true");
    if (opts.preset) qs.set("preset", opts.preset);
    if (opts.print) qs.set("print", "true");
    return requestFile(`/projects/${projectId}/wiki/pages/${id}/export?${qs}`);
  },
  exportZip: (projectId: string) => requestFile(`/projects/${projectId}/wiki/export.zip`),
  import: (projectId: string, file: File, parentId?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    if (parentId) form.append("parent_id", parentId);
    return upload<WikiPage>(`/projects/${projectId}/wiki/import`, form);
  },
  graph: (projectId: string, id: string, depth: 1 | 2) =>
    http.get<LocalGraph>(`/projects/${projectId}/wiki/pages/${id}/graph?depth=${depth}`),
  unlinkedMentions: (projectId: string, id: string) =>
    http.get<UnlinkedMention[]>(`/projects/${projectId}/wiki/pages/${id}/unlinked-mentions`),
  linkMentions: (projectId: string, id: string, sources: Pick<UnlinkedMention, "source_type" | "source_id">[]) =>
    http.post<{ linked: number; documents: number }>(`/projects/${projectId}/wiki/pages/${id}/unlinked-mentions/link`, { sources }),
};

export const knowledgeApi = {
  fullGraph: (projectId: string, includeKnowledge = true) =>
    http.get<ProjectGraph>(`/projects/${projectId}/graph?include_knowledge=${includeKnowledge}`),
  listGlossary: (projectId: string, q?: string) =>
    http.get<GlossaryTerm[]>(`/projects/${projectId}/glossary${q ? `?${new URLSearchParams({ q })}` : ""}`),
  createGlossary: (
    projectId: string,
    body: { term: string; definition?: string; synonyms?: string[]; broader_id?: string | null; wiki_page_id?: string | null },
  ) => http.post<GlossaryTerm>(`/projects/${projectId}/glossary`, body),
  updateGlossary: (
    projectId: string,
    id: string,
    body: { term?: string; definition?: string; synonyms?: string[]; broader_id?: string | null; wiki_page_id?: string | null },
  ) => http.patch<GlossaryTerm>(`/projects/${projectId}/glossary/${id}`, body),
  deleteGlossary: (projectId: string, id: string) => http.delete(`/projects/${projectId}/glossary/${id}`),
  glossaryUsages: (projectId: string, id: string) => http.get<GlossaryUsage[]>(`/projects/${projectId}/glossary/${id}/usages`),
  extract: (projectId: string) => http.post<ExtractResult>(`/projects/${projectId}/knowledge/extract`),
  listEntities: (projectId: string, status?: ReviewStatus) =>
    http.get<KnowledgeEntity[]>(`/projects/${projectId}/knowledge/entities${status ? `?status=${status}` : ""}`),
  createEntity: (
    projectId: string,
    body: { name: string; kind: EntityKind; description?: string; aliases?: string[]; status?: ReviewStatus },
  ) => http.post<KnowledgeEntity>(`/projects/${projectId}/knowledge/entities`, body),
  updateEntity: (
    projectId: string,
    id: string,
    body: { name?: string; kind?: EntityKind; description?: string; aliases?: string[]; status?: ReviewStatus },
  ) => http.patch<KnowledgeEntity>(`/projects/${projectId}/knowledge/entities/${id}`, body),
  deleteEntity: (projectId: string, id: string) => http.delete(`/projects/${projectId}/knowledge/entities/${id}`),
  listRelations: (projectId: string, status?: ReviewStatus) =>
    http.get<KnowledgeRelation[]>(`/projects/${projectId}/knowledge/relations${status ? `?status=${status}` : ""}`),
  createRelation: (
    projectId: string,
    body: { source_entity_id: string; target_entity_id: string; kind: RelationKind; evidence?: string; status?: ReviewStatus },
  ) => http.post<KnowledgeRelation>(`/projects/${projectId}/knowledge/relations`, body),
  updateRelation: (projectId: string, id: string, body: { kind?: RelationKind; evidence?: string; status?: ReviewStatus }) =>
    http.patch<KnowledgeRelation>(`/projects/${projectId}/knowledge/relations/${id}`, body),
  deleteRelation: (projectId: string, id: string) => http.delete(`/projects/${projectId}/knowledge/relations/${id}`),
  qa: (projectId: string, question: string) => http.post<QAResponse>(`/projects/${projectId}/knowledge/qa`, { question }),
};

export const githubApi = {
  getConfig: (projectId: string) => http.get<GitHubConfig>(`/projects/${projectId}/github`),
  saveConfig: (projectId: string, body: { repo: string; webhook_secret?: string; rotate_secret?: boolean; auto_transition: boolean }) =>
    http.put<GitHubConfig>(`/projects/${projectId}/github`, body),
  taskLinks: (projectId: string, taskId: string) => http.get<GitHubLink[]>(`/projects/${projectId}/tasks/${taskId}/github`),
};

export const webhooksApi = {
  list: (projectId: string) => http.get<ProjectWebhook[]>(`/projects/${projectId}/webhooks`),
  create: (
    projectId: string,
    body: {
      name: string;
      url: string;
      preset: WebhookPreset;
      events: string[];
      trigger_tags?: string[];
      trigger_stages?: string[];
      secret?: string;
      enabled?: boolean;
    },
  ) => http.post<ProjectWebhook>(`/projects/${projectId}/webhooks`, body),
  update: (
    projectId: string,
    id: string,
    body: Partial<{
      name: string;
      url: string;
      preset: WebhookPreset;
      events: string[];
      trigger_tags: string[];
      trigger_stages: string[];
      enabled: boolean;
    }>,
  ) => http.patch<ProjectWebhook>(`/projects/${projectId}/webhooks/${id}`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/webhooks/${id}`),
  test: (projectId: string, id: string) => http.post<WebhookDelivery>(`/projects/${projectId}/webhooks/${id}/test`),
  deliveries: (projectId: string, id: string) => http.get<WebhookDelivery[]>(`/projects/${projectId}/webhooks/${id}/deliveries`),
};

export const oauthApi = {
  getRequest: (id: string) => http.get<ConsentRequest>(`/oauth/requests/${id}`),
  decide: (id: string, approve: boolean, scopes: string[]) =>
    http.post<{ redirect_to: string }>(`/oauth/requests/${id}/decision`, { approve, scopes }),
  grants: () => http.get<OAuthGrant[]>("/oauth/grants"),
  revokeGrant: (id: string) => http.delete(`/oauth/grants/${id}`),
  mcpInfo: () => http.get<McpInfo>("/mcp-info"),
};
