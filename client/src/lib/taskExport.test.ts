import { describe, expect, it } from "vitest";
import { buildWeeklyStandupMarkdown, tasksToCsv, tasksToMarkdownTable } from "./taskExport";
import type { MyTask, PipelineStageInfo, Task, User } from "../types";

const stages: PipelineStageInfo[] = [
  { key: "backlog", label: "백로그" },
  { key: "in_progress", label: "진행 중" },
  { key: "done", label: "완료" },
];
const usersById = new Map<string, User>([
  ["u1", { id: "u1", email: "kim@ex.com", name: "김영수", picture: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", last_login_at: null }],
]);

const sampleTask: Task = {
  id: "t1",
  project_id: "p1",
  number: 12,
  title: '검색 "고도화", 필터 | 정렬',
  description: "",
  stage: "in_progress",
  priority: "high",
  parent_id: null,
  cycle_id: null,
  milestone_id: null,
  version: "v0.2.0",
  assignee_id: "u1",
  tags: ["search", "ux"],
  start_date: null,
  due_date: "2026-11-30",
  estimate: 3,
  checklist: [],
  comment_count: 0,
  subtask_count: 0,
  subtask_done: 0,
  created_by: "u1",
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-22T09:00:00Z",
};

describe("taskExport", () => {
  it("generates UTF-8 BOM CSV with proper quoting", () => {
    const csv = tasksToCsv([sampleTask], { projectKey: "MW", stages, usersById });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("MW-12");
    expect(csv).toContain('"검색 ""고도화"", 필터 | 정렬"');
    expect(csv).toContain("진행 중");
    expect(csv).toContain("김영수");
  });

  it("generates Markdown table escaping pipe characters", () => {
    const md = tasksToMarkdownTable([sampleTask], { projectKey: "MW", stages, usersById });
    expect(md).toContain("| MW-12 | 검색 \"고도화\", 필터 \\| 정렬 | 진행 중 | 높음 | v0.2.0 | 김영수 | 2026-11-30 |");
  });

  it("builds weekly standup Markdown grouped by recent done, active, and upcoming", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    const myTasks: MyTask[] = [
      { ...sampleTask, id: "a", number: 1, stage: "done", title: "최근 완료", updated_at: "2026-11-21T00:00:00Z", project_key: "MW", project_name: "마이티 워크" },
      { ...sampleTask, id: "b", number: 2, stage: "done", title: "오래된 완료", updated_at: "2026-10-01T00:00:00Z", project_key: "MW", project_name: "마이티 워크" },
      { ...sampleTask, id: "c", number: 3, stage: "in_progress", title: "진행 작업", project_key: "MW", project_name: "마이티 워크" },
      { ...sampleTask, id: "d", number: 4, stage: "todo", title: "예정 작업", project_key: "MW", project_name: "마이티 워크" },
    ];
    const report = buildWeeklyStandupMarkdown(myTasks, now);
    expect(report).toContain("MW-1");
    expect(report).not.toContain("MW-2"); // 7일 이전 완료 제외
    expect(report).toContain("MW-3");
    expect(report).toContain("MW-4");
  });
});
