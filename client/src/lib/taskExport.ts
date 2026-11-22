import { PRIORITY_LABEL } from "../features/tasks/tones";
import type { MyTask, PipelineStageInfo, Task, User } from "../types";

interface ExportContext {
  projectKey: string;
  stages: PipelineStageInfo[];
  usersById: Map<string, User>;
}

function csvCell(val: string | number | null | undefined): string {
  const s = val == null ? "" : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function mdCell(val: string | number | null | undefined): string {
  return (val == null ? "" : String(val)).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Excel 호환 UTF-8 BOM 포함 CSV 문자열 생성 */
export function tasksToCsv(tasks: Task[], { projectKey, stages, usersById }: ExportContext): string {
  const stageLabel = (key: string) => stages.find((s) => s.key === key)?.label ?? key;
  const header = ["키", "제목", "단계", "우선순위", "버전", "작업자", "마감일", "추정(pt)", "레이블", "수정일"];
  const rows = tasks.map((t) => {
    const assignee = t.assignee_id ? usersById.get(t.assignee_id) : undefined;
    return [
      `${projectKey}-${t.number}`,
      t.title,
      stageLabel(t.stage),
      PRIORITY_LABEL[t.priority] ?? t.priority,
      t.version ?? "",
      assignee ? assignee.name || assignee.email : "",
      t.due_date ?? "",
      t.estimate ?? "",
      t.tags.join("; "),
      t.updated_at.slice(0, 10),
    ]
      .map(csvCell)
      .join(",");
  });
  return "\uFEFF" + [header.map(csvCell).join(","), ...rows].join("\r\n");
}

/** GitHub Flavored Markdown 표 생성 */
export function tasksToMarkdownTable(tasks: Task[], { projectKey, stages, usersById }: ExportContext): string {
  const stageLabel = (key: string) => stages.find((s) => s.key === key)?.label ?? key;
  const lines = [
    "| 키 | 제목 | 단계 | 우선순위 | 버전 | 작업자 | 마감일 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const t of tasks) {
    const assignee = t.assignee_id ? usersById.get(t.assignee_id) : undefined;
    lines.push(
      `| ${mdCell(`${projectKey}-${t.number}`)} | ${mdCell(t.title)} | ${mdCell(stageLabel(t.stage))} | ${mdCell(PRIORITY_LABEL[t.priority] ?? t.priority)} | ${mdCell(t.version || "-")} | ${mdCell(assignee ? assignee.name || assignee.email : "-")} | ${mdCell(t.due_date || "-")} |`,
    );
  }
  return lines.join("\n");
}

/** 내 일감 기반 주간/데일리 보고서 Markdown 생성 */
export function buildWeeklyStandupMarkdown(tasks: MyTask[], now: Date = new Date()): string {
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const doneRecent = tasks.filter((t) => t.stage === "done" && Date.parse(t.updated_at) >= weekAgo);
  const active = tasks.filter((t) => t.stage === "in_progress" || t.stage === "review" || t.stage === "qa");
  const upcoming = tasks.filter((t) => t.stage === "todo" || t.stage === "backlog").slice(0, 12);

  const fmt = (t: MyTask) => {
    const ver = t.version ? ` \`${t.version}\`` : "";
    const due = t.due_date ? ` (마감 ${t.due_date})` : "";
    return `- **${t.project_key}-${t.number}** ${t.title}${ver}${due}`;
  };

  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const out: string[] = [`## 주간 업무 요약 (${todayStr})`, ""];

  out.push(`### 완료 (${doneRecent.length}건)`);
  if (doneRecent.length === 0) out.push("- 최근 7일 완료 항목 없음");
  else out.push(...doneRecent.map(fmt));
  out.push("");

  out.push(`### 진행 중 · 리뷰/QA (${active.length}건)`);
  if (active.length === 0) out.push("- 진행 중인 항목 없음");
  else out.push(...active.map(fmt));
  out.push("");

  out.push(`### 예정 (${upcoming.length}건)`);
  if (upcoming.length === 0) out.push("- 예정된 항목 없음");
  else out.push(...upcoming.map(fmt));

  return out.join("\n");
}
