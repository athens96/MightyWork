import type { PipelineStage, Priority } from "../../types";

/** 파이프라인 단계 → MightyCode 상태 톤 (styles.css 의 .tone-*) */
export const STAGE_TONE: Record<PipelineStage, string> = {
  backlog: "tone-stop",
  todo: "tone-idle",
  in_progress: "tone-run",
  review: "tone-agent",
  qa: "tone-task",
  done: "tone-done",
};

export const PRIORITY_META: Record<Priority, { label: string; tone: string } | null> = {
  low: null, // 낮음은 표시하지 않음
  medium: null,
  high: { label: "높음", tone: "tone-wait" },
  urgent: { label: "긴급", tone: "tone-err" },
};

export const PRIORITY_LABEL: Record<Priority, string> = { low: "낮음", medium: "보통", high: "높음", urgent: "긴급" };

export const FIELD_LABEL: Record<string, string> = {
  title: "제목",
  stage: "상태",
  priority: "우선순위",
  parent_id: "상위 일감",
  cycle_id: "사이클",
  assignee_id: "작업자",
  start_date: "시작일",
  due_date: "종료일",
  estimate: "추정치",
  tags: "레이블",
};

export const TASK_LINK_LABEL: Record<string, string> = {
  blocks: "차단함",
  blocked_by: "차단됨",
  relates_to: "관련됨",
  duplicates: "중복함",
  duplicated_by: "중복됨",
};
