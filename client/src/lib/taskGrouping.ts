import type { Cycle, Milestone, PipelineStage, PipelineStageInfo, Priority, Task, User } from "../types";
import { PRIORITY_LABEL, STAGE_TONE } from "../features/tasks/tones";

export type DoneDisplayMode = "monthly" | "recent7" | "all" | "hide";
export type GroupBy = "none" | "stage" | "priority" | "version" | "assignee" | "milestone" | "cycle";
export type StageGroupKey = "" | "in_progress" | "review_qa" | "done" | "todo_backlog";

export interface MonthBucket {
  key: string; // "YYYY-MM" 또는 "YYYY-MM:older"
  label: string;
  tasks: Task[];
}

export interface DonePartition {
  expanded: Task[];
  expandedLabel: string;
  buckets: MonthBucket[];
  hiddenCount: number;
}

export interface TaskGroup {
  key: string;
  label: string;
  tone?: string;
  tasks: Task[];
  isDoneGroup?: boolean;
}

const PRIORITY_ORDER: { key: Priority; tone: string }[] = [
  { key: "urgent", tone: "tone-err" },
  { key: "high", tone: "tone-wait" },
  { key: "medium", tone: "tone-idle" },
  { key: "low", tone: "tone-stop" },
];

/** 로컬 시간 기준 YYYY-MM 키 반환 */
export function getLocalMonthKey(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-10" → "2026년 10월" */
export function formatMonthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return "날짜 미상";
  return `${Number(m[1])}년 ${Number(m[2])}월`;
}

/** KPI 상단 타일 클릭 시 단계 그룹 매칭 */
export function matchesStageGroup(stage: PipelineStage, group: StageGroupKey): boolean {
  if (!group) return true;
  if (group === "in_progress") return stage === "in_progress";
  if (group === "review_qa") return stage === "review" || stage === "qa";
  if (group === "done") return stage === "done";
  if (group === "todo_backlog") return stage === "backlog" || stage === "todo";
  return true;
}

/** 보드·리스트 즉시 검색 (키·번호·제목·태그·에이전트 출처 다중 단어 AND 매칭) */
export function matchesQuickQuery(task: Task, projectKey: string, query: string): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    `${projectKey}-${task.number}`,
    `#${task.number}`,
    String(task.number),
    task.title,
    task.version ?? "",
    ...task.tags.map((t) => `#${t}`),
    task.via_client ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function versionSortTuple(ver: string): [number, number, number, number, string] | null {
  const cleaned = ver.trim().replace(/^v/i, "").split("-")[0];
  const m = /^(\d+)\.(\d+|x|\*)(?:\.(\d+|x|\*))?$/i.exec(cleaned);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = /^\d+$/.test(m[2]) ? Number(m[2]) : Number.MAX_SAFE_INTEGER;
  const patch = m[3] === undefined ? -1 : /^\d+$/.test(m[3]) ? Number(m[3]) : Number.MAX_SAFE_INTEGER;
  const isWildcard = /x|\*/i.test(cleaned) ? 1 : 0;
  return [major, minor, patch, isWildcard, ver];
}

/** 버전 문자열 목록을 최신 버전 순으로 자연 정렬 (예: v0.7.0 > v0.6.x > v0.6.0 > v0.5.10 > v0.5.9) */
export function sortVersionLabels(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const ta = versionSortTuple(a);
    const tb = versionSortTuple(b);
    if (ta && tb) {
      if (ta[0] !== tb[0]) return tb[0] - ta[0];
      if (ta[1] !== tb[1]) return tb[1] - ta[1];
      if (ta[2] !== tb[2]) return tb[2] - ta[2];
      if (ta[3] !== tb[3]) return tb[3] - ta[3];
      return b.localeCompare(a, undefined, { numeric: true });
    }
    if (ta) return -1;
    if (tb) return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

function taskTimestamp(t: Task): number {
  const ts = new Date(t.updated_at || t.created_at).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 완료(done) 일감을 표시 모드에 따라 "바로 펼칠 항목"과 "월별 접힘 묶음"으로 분리.
 * - monthly (기본): 이번 달 완료분은 펼치고, 지난달 이전은 YYYY-MM 월별 아코디언으로 묶음
 * - recent7: 최근 7일 완료분만 펼치고, 이전 항목은 월별 묶음
 * - all: 전체 펼침
 * - hide: 전체 숨김
 */
export function partitionDoneByMonth(doneTasks: Task[], mode: DoneDisplayMode, now: Date = new Date()): DonePartition {
  if (mode === "hide") {
    return { expanded: [], expandedLabel: "", buckets: [], hiddenCount: doneTasks.length };
  }

  // 완료 항목은 최신 완료(수정) 순이 가장 자연스러움
  const sorted = [...doneTasks].sort((a, b) => taskTimestamp(b) - taskTimestamp(a) || b.number - a.number);

  if (mode === "all") {
    return { expanded: sorted, expandedLabel: "전체 완료", buckets: [], hiddenCount: 0 };
  }

  const currentMonth = getLocalMonthKey(now);
  const cutoff7d = now.getTime() - 7 * 86_400_000;
  const expanded: Task[] = [];
  const bucketMap = new Map<string, Task[]>();

  for (const task of sorted) {
    const refIso = task.updated_at || task.created_at;
    const mk = getLocalMonthKey(refIso);
    const isExpanded = mode === "monthly" ? mk === currentMonth : taskTimestamp(task) >= cutoff7d;
    if (isExpanded) {
      expanded.push(task);
    } else {
      const list = bucketMap.get(mk) ?? [];
      list.push(task);
      bucketMap.set(mk, list);
    }
  }

  const buckets: MonthBucket[] = [...bucketMap.entries()]
    .sort(([a], [b]) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return b.localeCompare(a);
    })
    .map(([mk, tasks]) => ({
      key: mode === "recent7" && mk === currentMonth ? `${mk}:older` : mk,
      label: mode === "recent7" && mk === currentMonth ? `${formatMonthLabel(mk)} (7일 이전)` : formatMonthLabel(mk),
      tasks,
    }));

  return {
    expanded,
    expandedLabel: mode === "monthly" ? `이번 달 완료 (${now.getMonth() + 1}월)` : "최근 7일 완료",
    buckets,
    hiddenCount: 0,
  };
}

/** 일감 목록을 선택한 기준(단계/우선순위/작업자/마일스톤/사이클)으로 그룹핑 */
export function groupTasks(
  tasks: Task[],
  groupBy: GroupBy,
  ctx: {
    stages: PipelineStageInfo[];
    usersById: Map<string, User>;
    milestones: Milestone[];
    cycles: Cycle[];
  },
): TaskGroup[] {
  if (groupBy === "none") {
    return [{ key: "__all__", label: "전체", tasks }];
  }

  if (groupBy === "stage") {
    const groups: TaskGroup[] = [];
    for (const st of ctx.stages) {
      const items = tasks.filter((t) => t.stage === st.key);
      if (items.length === 0) continue;
      groups.push({
        key: st.key,
        label: st.label,
        tone: st.color || STAGE_TONE[st.key],
        tasks: items,
        isDoneGroup: st.key === "done",
      });
    }
    return groups;
  }

  if (groupBy === "priority") {
    const groups: TaskGroup[] = [];
    for (const p of PRIORITY_ORDER) {
      const items = tasks.filter((t) => t.priority === p.key);
      if (items.length === 0) continue;
      groups.push({
        key: p.key,
        label: PRIORITY_LABEL[p.key],
        tone: p.tone,
        tasks: items,
      });
    }
    return groups;
  }

  if (groupBy === "version") {
    const byVer = new Map<string, Task[]>();
    const noVer: Task[] = [];
    for (const t of tasks) {
      if (!t.version) {
        noVer.push(t);
      } else {
        const list = byVer.get(t.version) ?? [];
        list.push(t);
        byVer.set(t.version, list);
      }
    }
    const groups: TaskGroup[] = sortVersionLabels([...byVer.keys()]).map((ver) => ({
      key: ver,
      label: ver,
      tone: "tone-task",
      tasks: byVer.get(ver)!,
    }));
    if (noVer.length > 0) {
      groups.push({ key: "__none__", label: "버전 미지정", tone: "tone-stop", tasks: noVer });
    }
    return groups;
  }

  if (groupBy === "assignee") {
    const byAssignee = new Map<string, Task[]>();
    const unassigned: Task[] = [];
    for (const t of tasks) {
      if (!t.assignee_id) {
        unassigned.push(t);
      } else {
        const list = byAssignee.get(t.assignee_id) ?? [];
        list.push(t);
        byAssignee.set(t.assignee_id, list);
      }
    }
    const groups: TaskGroup[] = [...byAssignee.entries()]
      .map(([uid, items]) => {
        const u = ctx.usersById.get(uid);
        return { key: uid, label: u?.name || u?.email || "알 수 없음", tone: "tone-run", tasks: items };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
    if (unassigned.length > 0) {
      groups.push({ key: "__none__", label: "미지정", tone: "tone-stop", tasks: unassigned });
    }
    return groups;
  }

  if (groupBy === "milestone") {
    const statusOrder = { active: 0, planned: 1, completed: 2 } as const;
    const sortedMs = [...ctx.milestones].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
    const groups: TaskGroup[] = [];
    const seen = new Set<string>();
    for (const ms of sortedMs) {
      const items = tasks.filter((t) => t.milestone_id === ms.id);
      if (items.length === 0) continue;
      seen.add(ms.id);
      groups.push({
        key: ms.id,
        label: ms.name,
        tone: ms.status === "completed" ? "tone-done" : ms.status === "active" ? "tone-run" : "tone-idle",
        tasks: items,
      });
    }
    const rest = tasks.filter((t) => !t.milestone_id || !seen.has(t.milestone_id));
    if (rest.length > 0) {
      groups.push({ key: "__none__", label: "마일스톤 미지정", tone: "tone-stop", tasks: rest });
    }
    return groups;
  }

  // cycle
  const cycleOrder = { active: 0, upcoming: 1, completed: 2 } as const;
  const sortedCycles = [...ctx.cycles].sort((a, b) => cycleOrder[a.status] - cycleOrder[b.status]);
  const groups: TaskGroup[] = [];
  const seen = new Set<string>();
  for (const c of sortedCycles) {
    const items = tasks.filter((t) => t.cycle_id === c.id);
    if (items.length === 0) continue;
    seen.add(c.id);
    groups.push({
      key: c.id,
      label: c.status === "active" ? `● ${c.name}` : c.name,
      tone: c.status === "active" ? "tone-run" : c.status === "completed" ? "tone-done" : "tone-idle",
      tasks: items,
    });
  }
  const rest = tasks.filter((t) => !t.cycle_id || !seen.has(t.cycle_id));
  if (rest.length > 0) {
    groups.push({ key: "__none__", label: "사이클 미지정", tone: "tone-stop", tasks: rest });
  }
  return groups;
}
