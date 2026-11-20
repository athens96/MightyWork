import { http, requestFile, upload } from "./http";

export type ExportFormat = "md" | "html" | "docx" | "hwpx" | "hwp";
import type {
  Comment,
  ConsentRequest,
  McpInfo,
  OAuthGrant,
  Member,
  LocalGraph,
  PageLinks,
  SearchHit,
  UnlinkedMention,
  Permission,
  PipelineStage,
  PipelineStageInfo,
  Project,
  ProjectCreate,
  ProjectUpdate,
  Task,
  TaskActivity,
  TaskCreate,
  TaskUpdate,
  TokenResponse,
  User,
  WikiPage,
  WikiPageCreate,
  WikiPageSummary,
  WikiPageUpdate,
} from "../types";

export const authApi = {
  loginWithGoogle: (credential: string) => http.post<TokenResponse>("/auth/google", { credential }),
  me: () => http.get<User>("/auth/me"),
};

export const usersApi = {
  list: () => http.get<User[]>("/users"),
};

export const projectsApi = {
  list: () => http.get<Project[]>("/projects"),
  get: (id: string) => http.get<Project>(`/projects/${id}`),
  create: (body: ProjectCreate) => http.post<Project>("/projects", body),
  update: (id: string, body: ProjectUpdate) => http.patch<Project>(`/projects/${id}`, body),
  remove: (id: string) => http.delete(`/projects/${id}`),
};

export const membersApi = {
  list: (projectId: string) => http.get<Member[]>(`/projects/${projectId}/members`),
  add: (projectId: string, email: string, permissions: Permission[]) =>
    http.post<Member>(`/projects/${projectId}/members`, { email, permissions }),
  update: (projectId: string, id: string, permissions: Permission[]) =>
    http.patch<Member>(`/projects/${projectId}/members/${id}`, { permissions }),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/members/${id}`),
};

export const pipelineApi = {
  get: () => http.get<PipelineStageInfo[]>("/pipeline"),
};

export const tasksApi = {
  list: (projectId: string, params: { stage?: PipelineStage; assignee_id?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return http.get<Task[]>(`/projects/${projectId}/tasks${qs.size ? `?${qs}` : ""}`);
  },
  get: (projectId: string, id: string) => http.get<Task>(`/projects/${projectId}/tasks/${id}`),
  create: (projectId: string, body: TaskCreate) => http.post<Task>(`/projects/${projectId}/tasks`, body),
  update: (projectId: string, id: string, body: TaskUpdate) =>
    http.patch<Task>(`/projects/${projectId}/tasks/${id}`, body),
  remove: (projectId: string, id: string) => http.delete(`/projects/${projectId}/tasks/${id}`),
  activity: (projectId: string, id: string) =>
    http.get<TaskActivity[]>(`/projects/${projectId}/tasks/${id}/activity`),
  wikiRefs: (projectId: string, id: string) => http.get<WikiPageSummary[]>(`/projects/${projectId}/tasks/${id}/wiki-refs`),
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

export const oauthApi = {
  getRequest: (id: string) => http.get<ConsentRequest>(`/oauth/requests/${id}`),
  decide: (id: string, approve: boolean, scopes: string[]) =>
    http.post<{ redirect_to: string }>(`/oauth/requests/${id}/decision`, { approve, scopes }),
  grants: () => http.get<OAuthGrant[]>("/oauth/grants"),
  revokeGrant: (id: string) => http.delete(`/oauth/grants/${id}`),
  mcpInfo: () => http.get<McpInfo>("/mcp-info"),
};
