import { describe, expect, it } from "vitest";
import type { Cycle, Milestone, PipelineStageInfo, Task, User } from "../types";
import { formatMonthLabel, groupTasks, matchesQuickQuery, matchesStageGroup, partitionDoneByMonth, sortVersionLabels } from "./taskGrouping";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? `t-${overrides.number ?? 1}`,
    project_id: "p1",
    number: overrides.number ?? 1,
    title: overrides.title ?? "테스트 일감",
    description: "",
    stage: overrides.stage ?? "done",
    priority: overrides.priority ?? "medium",
    parent_id: null,
    cycle_id: overrides.cycle_id ?? null,
    milestone_id: overrides.milestone_id ?? null,
    version: overrides.version ?? null,
    assignee_id: overrides.assignee_id ?? null,
    tags: overrides.tags ?? [],
    start_date: null,
    due_date: null,
    estimate: null,
    checklist: [],
    comment_count: 0,
    subtask_count: 0,
    subtask_done: 0,
    created_by: "u1",
    via_client: overrides.via_client ?? null,
    created_at: overrides.created_at ?? "2026-10-01T09:00:00+09:00",
    updated_at: overrides.updated_at ?? "2026-11-15T09:00:00+09:00",
  };
}

describe("partitionDoneByMonth", () => {
  const now = new Date("2026-11-22T12:00:00+09:00");
  const tasks: Task[] = [
    makeTask({ number: 1, title: "9월 완료", updated_at: "2026-09-20T10:00:00+09:00" }),
    makeTask({ number: 2, title: "10월 초 완료", updated_at: "2026-10-03T10:00:00+09:00" }),
    makeTask({ number: 3, title: "10월 말 완료", updated_at: "2026-10-29T10:00:00+09:00" }),
    makeTask({ number: 4, title: "11월 초 완료", updated_at: "2026-11-05T10:00:00+09:00" }),
    makeTask({ number: 5, title: "어제 완료", updated_at: "2026-11-21T10:00:00+09:00" }),
  ];

  it("monthly 모드는 이번 달만 펼치고 이전 달을 최신 월순 아코디언으로 묶는다", () => {
    const res = partitionDoneByMonth(tasks, "monthly", now);
    expect(res.hiddenCount).toBe(0);
    expect(res.expandedLabel).toBe("이번 달 완료 (11월)");
    expect(res.expanded.map((t) => t.number)).toEqual([5, 4]);
    expect(res.buckets.map((b) => ({ key: b.key, label: b.label, nums: b.tasks.map((t) => t.number) }))).toEqual([
      { key: "2026-10", label: "2026년 10월", nums: [3, 2] },
      { key: "2026-09", label: "2026년 9월", nums: [1] },
    ]);
  });

  it("recent7 모드는 최근 7일만 펼치고 같은 달 이전 항목도 별도 묶음으로 분리한다", () => {
    const res = partitionDoneByMonth(tasks, "recent7", now);
    expect(res.expanded.map((t) => t.number)).toEqual([5]);
    expect(res.buckets.map((b) => ({ key: b.key, label: b.label, nums: b.tasks.map((t) => t.number) }))).toEqual([
      { key: "2026-11:older", label: "2026년 11월 (7일 이전)", nums: [4] },
      { key: "2026-10", label: "2026년 10월", nums: [3, 2] },
      { key: "2026-09", label: "2026년 9월", nums: [1] },
    ]);
  });

  it("hide 모드는 모든 완료 일감을 숨기고 건수를 반환한다", () => {
    const res = partitionDoneByMonth(tasks, "hide", now);
    expect(res.expanded).toEqual([]);
    expect(res.buckets).toEqual([]);
    expect(res.hiddenCount).toBe(5);
  });

  it("all 모드는 모든 완료 일감을 최신순으로 펼친다", () => {
    const res = partitionDoneByMonth(tasks, "all", now);
    expect(res.expanded.map((t) => t.number)).toEqual([5, 4, 3, 2, 1]);
    expect(res.buckets).toEqual([]);
  });
});

describe("matchesQuickQuery & matchesStageGroup & formatMonthLabel", () => {
  const task = makeTask({ number: 15, title: "모바일 반응형 레이아웃 개선", tags: ["mobile", "pwa"], via_client: "MightyCode" });

  it("키, 번호, 제목, 태그, 에이전트 출처를 다중 단어 AND로 매칭한다", () => {
    expect(matchesQuickQuery(task, "MW", "")).toBe(true);
    expect(matchesQuickQuery(task, "MW", "mw-15")).toBe(true);
    expect(matchesQuickQuery(task, "MW", "모바일 #pwa")).toBe(true);
    expect(matchesQuickQuery(task, "MW", "mightycode")).toBe(true);
    expect(matchesQuickQuery(task, "MW", "모바일 데스크톱")).toBe(false);
  });

  it("KPI 단계 그룹 필터가 정확히 매칭된다", () => {
    expect(matchesStageGroup("in_progress", "in_progress")).toBe(true);
    expect(matchesStageGroup("review", "review_qa")).toBe(true);
    expect(matchesStageGroup("qa", "review_qa")).toBe(true);
    expect(matchesStageGroup("backlog", "todo_backlog")).toBe(true);
    expect(matchesStageGroup("todo", "todo_backlog")).toBe(true);
    expect(matchesStageGroup("done", "done")).toBe(true);
    expect(matchesStageGroup("done", "in_progress")).toBe(false);
  });

  it("월 키를 한국어 라벨로 포맷한다", () => {
    expect(formatMonthLabel("2026-01")).toBe("2026년 1월");
    expect(formatMonthLabel("unknown")).toBe("날짜 미상");
  });
});

describe("groupTasks", () => {
  const stages: PipelineStageInfo[] = [
    { key: "todo", label: "할 일" },
    { key: "in_progress", label: "진행 중" },
    { key: "done", label: "완료" },
  ];
  const usersById = new Map<string, User>([
    ["u1", { id: "u1", email: "a@test.com", name: "김영", picture: null, created_at: "", updated_at: "", last_login_at: null }],
    ["u2", { id: "u2", email: "b@test.com", name: "박지", picture: null, created_at: "", updated_at: "", last_login_at: null }],
  ]);
  const milestones: Milestone[] = [
    {
      id: "m1",
      project_id: "p1",
      name: "v0.2 릴리즈",
      description: "",
      start_date: null,
      target_date: null,
      status: "active",
      created_by: "u1",
      created_at: "",
      updated_at: "",
      total_tasks: 1,
      done_tasks: 0,
      in_progress_tasks: 1,
      total_points: 0,
      done_points: 0,
      progress_pct: 0,
    },
  ];
  const cycles: Cycle[] = [
    {
      id: "c1",
      project_id: "p1",
      name: "Sprint 1",
      goal: "",
      start_date: "2026-11-01",
      end_date: "2026-11-14",
      target_points: null,
      status: "active",
      created_by: "u1",
      created_at: "",
      updated_at: "",
      total_tasks: 1,
      done_tasks: 0,
      total_points: 0,
      done_points: 0,
      completion_pct: 0,
      burndown: [],
    },
  ];
  const items = [
    makeTask({ number: 1, stage: "todo", priority: "low", assignee_id: null, version: "v0.5.9" }),
    makeTask({ number: 2, stage: "in_progress", priority: "urgent", assignee_id: "u2", milestone_id: "m1", cycle_id: "c1", version: "v0.5.10" }),
    makeTask({ number: 3, stage: "done", priority: "high", assignee_id: "u1", version: null }),
  ];
  const ctx = { stages, usersById, milestones, cycles };

  it("버전별 그룹핑과 자연 정렬이 v0.5.10 > v0.5.9 순으로 동작한다", () => {
    expect(sortVersionLabels(["v0.5.9", "v0.6.0", "v0.5.10", "v0.6.x", "v0.7.0"])).toEqual([
      "v0.7.0",
      "v0.6.x",
      "v0.6.0",
      "v0.5.10",
      "v0.5.9",
    ]);
    const groups = groupTasks(items, "version", ctx);
    expect(groups.map((g) => g.label)).toEqual(["v0.5.10", "v0.5.9", "버전 미지정"]);
    expect(matchesQuickQuery(items[1], "MC", "v0.5.10")).toBe(true);
  });

  it("우선순위별 그룹핑이 긴급 → 높음 → 낮음 순으로 정렬된다", () => {
    const groups = groupTasks(items, "priority", ctx);
    expect(groups.map((g) => g.key)).toEqual(["urgent", "high", "low"]);
  });

  it("작업자별 그룹핑은 이름순 정렬 후 미지정을 마지막에 둔다", () => {
    const groups = groupTasks(items, "assignee", ctx);
    expect(groups.map((g) => g.label)).toEqual(["김영", "박지", "미지정"]);
  });

  it("단계별·마일스톤별·사이클별 그룹핑이 정상 동작한다", () => {
    const byStage = groupTasks(items, "stage", ctx);
    expect(byStage.map((g) => ({ key: g.key, done: !!g.isDoneGroup }))).toEqual([
      { key: "todo", done: false },
      { key: "in_progress", done: false },
      { key: "done", done: true },
    ]);
    expect(groupTasks(items, "milestone", ctx).map((g) => g.label)).toEqual(["v0.2 릴리즈", "마일스톤 미지정"]);
    expect(groupTasks(items, "cycle", ctx).map((g) => g.label)).toEqual(["● Sprint 1", "사이클 미지정"]);
  });
});
