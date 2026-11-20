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
}

export type ProjectCreate = Pick<Project, "key" | "name"> & Partial<Pick<Project, "description">>;
export type ProjectUpdate = Partial<Pick<Project, "name" | "description">>;

export type PipelineStage = "backlog" | "todo" | "in_progress" | "review" | "qa" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface PipelineStageInfo {
  key: PipelineStage;
  label: string;
}

export interface ChecklistItem {
  id?: string; // 새 항목은 서버가 발급
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string; // Markdown
  stage: PipelineStage;
  priority: Priority;
  assignee_id: string | null; // 작업자
  tags: string[]; // 레이블
  start_date: string | null; // YYYY-MM-DD
  due_date: string | null;
  estimate: number | null; // 스토리 포인트
  checklist: ChecklistItem[]; // 할 일
  comment_count: number; // 응답 전용
  created_by: string; // 보고자
  created_at: string;
  updated_at: string;
}

type TaskServerFields = "id" | "project_id" | "number" | "created_by" | "created_at" | "updated_at" | "comment_count";
export type TaskCreate = Pick<Task, "title"> & Partial<Omit<Task, TaskServerFields>>;
export type TaskUpdate = Partial<Omit<Task, TaskServerFields>>;

export interface WikiPage {
  id: string;
  title: string;
  content: string;
  parent_id: string | null;
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
  updated_at: string;
}

export type WikiPageCreate = Pick<WikiPage, "title"> & Partial<Pick<WikiPage, "content" | "parent_id">>;
export type WikiPageUpdate = Partial<Pick<WikiPage, "title" | "content" | "parent_id">>;

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

export interface Comment {
  id: string;
  project_id: string;
  task_id: string;
  author_id: string;
  body: string; // Markdown
  created_at: string;
  updated_at: string;
}

export type TrackedField = "title" | "stage" | "priority" | "assignee_id" | "start_date" | "due_date" | "estimate" | "tags";

export interface TaskActivity {
  id: string;
  task_id: string;
  actor_id: string;
  kind: "created" | "updated";
  field: TrackedField | null;
  old: unknown;
  new: unknown;
  created_at: string;
}
