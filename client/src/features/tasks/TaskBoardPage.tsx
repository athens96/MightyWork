import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { Link, Outlet, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { cyclesApi, membersApi, milestonesApi, pipelineApi, tasksApi, triageApi, usersApi, viewsApi } from "../../api";
import { can as canDo } from "../../lib/permissions";
import { useAuth } from "../../auth/AuthContext";
import { ChevronIcon, CloseIcon, PlusIcon, SearchIcon } from "../../components/icons";
import { TASK_CREATED_EVENT } from "../../components/QuickCreateModal";
import { RefreshButton } from "../../components/RefreshButton";
import { PROJECT_EVENT, subscribeSSE, type ProjectEventDetail, type SSEStatus } from "../../lib/sse";
import {
  groupTasks,
  matchesQuickQuery,
  matchesStageGroup,
  partitionDoneByMonth,
  sortVersionLabels,
  type DoneDisplayMode,
  type GroupBy,
  type StageGroupKey,
} from "../../lib/taskGrouping";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { dueState } from "../../lib/time";
import type { Cycle, Milestone, Permission, PipelineStage, PipelineStageInfo, Priority, SavedView, Task, TaskBulkRequest, TaskUpdate, User } from "../../types";
import { useCurrentProject } from "../projects/ProjectLayout";
import type { BoardContext } from "./boardContext";
import { TaskCard } from "./TaskCard";
import { TaskListView } from "./TaskListView";
import { TaskTimelineView } from "./TaskTimelineView";
import { PRIORITY_LABEL, STAGE_TONE } from "./tones";

// 상세 패널(마크다운 렌더러 포함)은 열 때만 로드
export const TaskDetailPanel = lazy(() => import("./TaskDetailPanel").then((m) => ({ default: m.TaskDetailPanel })));
export function TaskDetailRoute() {
  return (
    <Suspense fallback={null}>
      <TaskDetailPanel />
    </Suspense>
  );
}

type ViewLayout = "board" | "list" | "timeline";
type SortKey = "number" | "updated" | "priority" | "due";
const PRIO_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const VALID_DONE_MODES: readonly DoneDisplayMode[] = ["monthly", "recent7", "hide", "all"];
const VALID_GROUPS: readonly GroupBy[] = ["none", "stage", "priority", "version", "assignee", "milestone", "cycle"];
const COL_PAGE_SIZE = 12;
const DENSITY_KEY = "mw:board-density";

function loadCollapsedCols(projectId: string): Set<PipelineStage> {
  try {
    const raw = localStorage.getItem(`mw:collapsed-cols:${projectId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr as PipelineStage[]) : new Set();
  } catch {
    return new Set();
  }
}

/** 프로젝트 일감 화면: 보드 / 리스트 / 타임라인 + 완료 월별 묶음 · 컴팩트 밀도 · 스윔레인 · 컬럼 접기 · KPI 필터 */
export function TaskBoardPage() {
  const project = useCurrentProject();
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const openTaskId = useMatch("/projects/:projectId/tasks/:taskId")?.params.taskId;

  const [stages, setStages] = useState<PipelineStageInfo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [triageCount, setTriageCount] = useState(0);
  const [newTitle, setNewTitle] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<PipelineStage | null>(null);
  const [liveStatus, setLiveStatus] = useState<SSEStatus>("reconnecting");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [bulkVersion, setBulkVersion] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // MW-16: 대량 일감 정리 UI 상태
  const [compact, setCompact] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DENSITY_KEY) === "compact";
    } catch {
      return false;
    }
  });
  const [collapsedCols, setCollapsedCols] = useState<Set<PipelineStage>>(() => loadCollapsedCols(project.id));
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set());
  const [expandedLongCols, setExpandedLongCols] = useState<Set<string>>(() => new Set());
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(() => new Set());
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

  useEffect(() => {
    setCollapsedCols(loadCollapsedCols(project.id));
    setExpandedMonths(new Set());
    setExpandedLongCols(new Set());
    setCollapsedLanes(new Set());
  }, [project.id]);

  const toggleCompact = () => {
    setCompact((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DENSITY_KEY, next ? "compact" : "comfortable");
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
  };

  const toggleCollapseCol = (stageKey: PipelineStage) => {
    setCollapsedCols((prev) => {
      const next = new Set(prev);
      if (next.has(stageKey)) next.delete(stageKey);
      else next.add(stageKey);
      try {
        localStorage.setItem(`mw:collapsed-cols:${project.id}`, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const toggleMonth = (key: string) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleLongCol = (key: string) => {
    setExpandedLongCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleLane = (key: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const layout = (params.get("view") as ViewLayout) || "board";
  const assignee = params.get("assignee") || "all";
  const priority = params.get("priority") || "";
  const tag = params.get("tag") || "";
  const dueFilter = params.get("due") || "";
  const cycleFilter = params.get("cycle") || "";
  const milestoneFilter = params.get("milestone") || "";
  const versionFilter = params.get("ver") || "";
  const sort = (params.get("sort") as SortKey) || "number";
  const quickQuery = params.get("q") || "";
  const stageGroup = (params.get("sg") as StageGroupKey) || "";
  const rawDone = params.get("done") as DoneDisplayMode | null;
  const doneMode: DoneDisplayMode = rawDone && VALID_DONE_MODES.includes(rawDone) ? rawDone : "monthly";
  const rawGroup = params.get("group") as GroupBy | null;
  const validGroup = rawGroup && VALID_GROUPS.includes(rawGroup) ? rawGroup : null;
  const boardGroupBy: GroupBy = validGroup && validGroup !== "stage" ? validGroup : "none";
  const listGroupBy: GroupBy = validGroup ?? "stage";

  const setParam = (key: string, val: string) => {
    const next = new URLSearchParams(params);
    if (
      !val ||
      (key === "assignee" && val === "all") ||
      (key === "view" && val === "board") ||
      (key === "sort" && val === "number") ||
      (key === "done" && val === "monthly") ||
      (key === "group" && ((layout === "board" && val === "none") || (layout === "list" && val === "stage")))
    ) {
      next.delete(key);
    } else {
      next.set(key, val);
    }
    setParams(next, { replace: true });
  };

  const toggleStageGroup = (target: Exclude<StageGroupKey, "">) => {
    const next = new URLSearchParams(params);
    if (stageGroup === target) {
      next.delete("sg");
    } else {
      next.set("sg", target);
      if (target === "done" && doneMode === "hide") {
        next.delete("done"); // 완료 타일 클릭 시 숨김 모드 해제
      }
    }
    setParams(next, { replace: true });
  };

  const reload = useCallback(async () => {
    const [p, t, u, m, v, c, ms, tr] = await Promise.all([
      pipelineApi.forProject(project.id),
      tasksApi.list(project.id),
      usersApi.listByProject(project.id),
      membersApi.list(project.id),
      viewsApi.list(project.id).catch(() => [] as SavedView[]),
      cyclesApi.list(project.id).catch(() => [] as Cycle[]),
      milestonesApi.list(project.id).catch(() => [] as Milestone[]),
      triageApi.list(project.id).catch(() => [] as Task[]),
    ]);
    setStages(p);
    setTasks(t);
    setUsers(u);
    setMembers(m.flatMap((x) => (x.user ? [x.user] : [])));
    setSavedViews(v);
    setCycles(c);
    setMilestones(ms);
    setTriageCount(tr.filter((x) => x.triage_status === "pending").length);
  }, [project.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const { refreshing, lastUpdated, refresh, markUpdated } = useAutoRefresh(reload, {
    intervalMs: 30_000,
    shortcutKey: true,
  });

  useEffect(() => {
    const onQuick = (e: Event) => {
      const created = (e as CustomEvent<Task>).detail;
      if (created?.project_id === project.id) {
        setTasks((prev) => (prev.some((x) => x.id === created.id) ? prev : [...prev, created]));
        markUpdated();
      }
    };
    window.addEventListener(TASK_CREATED_EVENT, onQuick);
    return () => window.removeEventListener(TASK_CREATED_EVENT, onQuick);
  }, [project.id, markUpdated]);

  // MW-5 & MW-14: SSE 실시간 프로젝트 스트림 구독 + 재연결 시 전체 동기화
  useEffect(() => {
    let refreshTimer: number | undefined;
    const stop = subscribeSSE(
      `/projects/${project.id}/events`,
      (msg) => {
        window.dispatchEvent(
          new CustomEvent<ProjectEventDetail>(PROJECT_EVENT, {
            detail: { projectId: project.id, event: msg.event, data: msg.data },
          }),
        );
        if (msg.event === "pipeline.updated") {
          pipelineApi.forProject(project.id).then((p) => {
            setStages(p);
            markUpdated();
          }, () => {});
        }
        if (msg.event === "cycle.updated") {
          cyclesApi.list(project.id).then(setCycles, () => {});
        }
        if (msg.event === "milestone.updated") {
          milestonesApi.list(project.id).then(setMilestones, () => {});
        }
        if (msg.event === "triage.updated") {
          triageApi.list(project.id).then((tr) => setTriageCount(tr.filter((x) => x.triage_status === "pending").length), () => {});
        }
        if (msg.event.startsWith("task.") || msg.event.startsWith("comment.") || msg.event === "github.linked") {
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            tasksApi.list(project.id).then((list) => {
              setTasks(list);
              markUpdated();
            }, () => {});
          }, 150);
        }
      },
      setLiveStatus,
      () => {
        void reload().then(markUpdated, () => {});
      },
    );
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      stop();
    };
  }, [project.id, reload, markUpdated]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const allTags = useMemo(() => [...new Set(tasks.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b)), [tasks]);
  const allVersions = useMemo(
    () => sortVersionLabels([...new Set(tasks.flatMap((t) => (t.version ? [t.version] : [])))]),
    [tasks],
  );

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const task = await tasksApi.create(project.id, { title: newTitle.trim() });
    setTasks((prev) => [...prev, task]);
    setNewTitle("");
    navigate(`/projects/${project.id}/tasks/${task.id}`);
  };

  const onCreated = useCallback((task: Task) => setTasks((prev) => [...prev, task]), []);
  const onChanged = useCallback((task: Task) => setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t))), []);
  const onDeleted = useCallback((id: string) => setTasks((prev) => prev.filter((t) => t.id !== id)), []);

  // 1단계 필터 (KPI 타일 수치의 기준)
  const baseFiltered = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (assignee === "me" && t.assignee_id !== me?.id) return false;
      if (assignee === "none" && t.assignee_id) return false;
      if (!["all", "me", "none"].includes(assignee) && t.assignee_id !== assignee) return false;
      if (priority && t.priority !== priority) return false;
      if (tag && !t.tags.includes(tag)) return false;
      if (dueFilter) {
        const st = dueState(t.due_date, t.stage === "done");
        if (dueFilter === "overdue" && st !== "overdue") return false;
        if (dueFilter === "soon" && st !== "soon" && st !== "overdue") return false;
        if (dueFilter === "has_due" && !t.due_date) return false;
      }
      if (cycleFilter === "none" && t.cycle_id) return false;
      if (cycleFilter && cycleFilter !== "none" && t.cycle_id !== cycleFilter) return false;
      if (milestoneFilter === "none" && t.milestone_id) return false;
      if (milestoneFilter && milestoneFilter !== "none" && t.milestone_id !== milestoneFilter) return false;
      if (versionFilter === "none" && t.version) return false;
      if (versionFilter && versionFilter !== "none" && t.version !== versionFilter) return false;
      if (quickQuery && !matchesQuickQuery(t, project.key, quickQuery)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === "updated") return b.updated_at.localeCompare(a.updated_at);
      if (sort === "priority") return PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || a.number - b.number;
      if (sort === "due") {
        if (!a.due_date && !b.due_date) return a.number - b.number;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date.localeCompare(b.due_date);
      }
      return a.number - b.number;
    });
  }, [tasks, assignee, priority, tag, dueFilter, cycleFilter, milestoneFilter, versionFilter, quickQuery, project.key, sort, me?.id]);

  // 2단계 필터 (KPI 타일 단계 그룹 선택 적용)
  const visible = useMemo(
    () => (stageGroup ? baseFiltered.filter((t) => matchesStageGroup(t.stage, stageGroup)) : baseFiltered),
    [baseFiltered, stageGroup],
  );

  const countBase = (...s: PipelineStage[]) => baseFiltered.filter((t) => s.includes(t.stage)).length;
  const advancedFilterCount =
    (!["all", "me", "none"].includes(assignee) ? 1 : 0) +
    (priority ? 1 : 0) +
    (tag ? 1 : 0) +
    (dueFilter ? 1 : 0) +
    (cycleFilter ? 1 : 0) +
    (milestoneFilter ? 1 : 0) +
    (sort !== "number" ? 1 : 0);
  const showAdvancedFilters = moreFiltersOpen || advancedFilterCount > 0;
  const hasFilters =
    assignee !== "all" ||
    advancedFilterCount > 0 ||
    !!versionFilter ||
    !!quickQuery ||
    !!stageGroup ||
    doneMode !== "monthly" ||
    (layout === "board" ? boardGroupBy !== "none" : listGroupBy !== "stage");

  const visibleStages = useMemo(() => {
    const active = stages.filter((s) => !s.hidden);
    return active.length > 0 ? active : stages;
  }, [stages]);

  // 보드에서 실제로 렌더할 컬럼 (KPI 타일 필터 및 '완료 숨김' 반영)
  const boardStages = useMemo(() => {
    return visibleStages.filter((s) => {
      if (stageGroup && !matchesStageGroup(s.key, stageGroup)) return false;
      if (s.key === "done" && doneMode === "hide" && stageGroup !== "done") return false;
      return true;
    });
  }, [visibleStages, stageGroup, doneMode]);

  const hiddenDoneCount = doneMode === "hide" && stageGroup !== "done" ? visible.filter((t) => t.stage === "done").length : 0;

  const boardSwimlanes = useMemo(() => {
    if (layout !== "board" || boardGroupBy === "none") return null;
    const pool = doneMode === "hide" && stageGroup !== "done" ? visible.filter((t) => t.stage !== "done") : visible;
    return groupTasks(pool, boardGroupBy, { stages: boardStages, usersById, milestones, cycles });
  }, [layout, boardGroupBy, visible, doneMode, stageGroup, boardStages, usersById, milestones, cycles]);

  const can = (perm: Permission) => canDo(project, perm);
  const canEdit = can("edit");
  const context: BoardContext = { project, tasks, stages: visibleStages, cycles, milestones, users, members, can, onCreated, onChanged, onDeleted };

  const patchTask = async (taskId: string, body: TaskUpdate) => {
    const current = tasks.find((t) => t.id === taskId);
    if (!current || !canEdit) return;
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...body } : t)));
    try {
      const updated = await tasksApi.update(project.id, taskId, body);
      onChanged(updated);
    } catch {
      onChanged(current);
    }
  };

  const moveStage = (taskId: string, target: PipelineStage) => {
    const current = tasks.find((t) => t.id === taskId);
    if (!current || current.stage === target) return;
    if (
      target === "in_progress" &&
      (current.blocked_by_count ?? 0) > 0 &&
      !confirm(`미완료 선행 일감 ${current.blocked_by_count}건에 차단되어 있습니다. 그래도 '진행 중'으로 이동할까요?`)
    ) {
      return;
    }
    patchTask(taskId, { stage: target });
  };

  const handleDrop = (e: DragEvent, target: PipelineStage) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain") || draggingId;
    setDropStage(null);
    setDraggingId(null);
    if (taskId) moveStage(taskId, target);
  };

  const saveCurrentView = async () => {
    const name = prompt("현재 뷰 이름 (예: 긴급 버그, 이번 달 완료, 내 진행 업무)");
    if (!name?.trim()) return;
    const filters: Record<string, string> = {};
    if (assignee !== "all") filters.assignee = assignee;
    if (priority) filters.priority = priority;
    if (tag) filters.tag = tag;
    if (dueFilter) filters.due = dueFilter;
    if (cycleFilter) filters.cycle = cycleFilter;
    if (milestoneFilter) filters.milestone = milestoneFilter;
    if (versionFilter) filters.ver = versionFilter;
    if (sort !== "number") filters.sort = sort;
    if (quickQuery) filters.q = quickQuery;
    if (stageGroup) filters.sg = stageGroup;
    if (doneMode !== "monthly") filters.done = doneMode;
    if (rawGroup) filters.group = rawGroup;
    const created = await viewsApi.create(project.id, { name: name.trim(), layout, filters });
    setSavedViews((prev) => [...prev, created]);
  };

  const applyView = (v: SavedView) => {
    const next = new URLSearchParams();
    if (v.layout !== "board") next.set("view", v.layout);
    for (const [k, val] of Object.entries(v.filters)) {
      if (val) next.set(k, val);
    }
    setParams(next, { replace: true });
  };

  const removeView = async (v: SavedView) => {
    if (!confirm(`저장된 뷰 '${v.name}' 을 삭제할까요?`)) return;
    await viewsApi.remove(project.id, v.id);
    setSavedViews((prev) => prev.filter((x) => x.id !== v.id));
  };

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback((checked: boolean, visibleIds: string[]) => {
    setSelectedIds(checked ? new Set(visibleIds) : new Set());
  }, []);

  const runBulk = async (patch: Omit<TaskBulkRequest, "task_ids">) => {
    const ids = [...selectedIds];
    if (ids.length === 0 || bulkBusy) return;
    if (patch.delete && !confirm(`선택한 일감 ${ids.length}건을 삭제할까요?`)) return;
    setBulkBusy(true);
    try {
      const res = await tasksApi.bulk(project.id, { task_ids: ids, ...patch });
      if (patch.delete) {
        const gone = new Set(ids);
        setTasks((prev) => prev.filter((t) => !gone.has(t.id)));
      } else if (res.tasks.length > 0) {
        const byId = new Map(res.tasks.map((t) => [t.id, t]));
        setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
      }
      setSelectedIds(new Set());
      setBulkTag("");
      setBulkVersion("");
    } finally {
      setBulkBusy(false);
    }
  };

  const renderCard = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      taskKey={`${project.key}-${task.number}`}
      href={`/projects/${project.id}/tasks/${task.id}`}
      assignee={task.assignee_id ? usersById.get(task.assignee_id) : undefined}
      stages={stages}
      selected={task.id === openTaskId}
      compact={compact}
      checked={selectedIds.has(task.id)}
      onToggleCheck={canEdit ? toggleSelect : undefined}
      onMoveStage={canEdit ? moveStage : undefined}
      draggable={canEdit}
      dragging={draggingId === task.id}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        setDraggingId(task.id);
      }}
      onDragEnd={() => {
        setDraggingId(null);
        setDropStage(null);
      }}
    />
  );

  const renderColumn = (stage: PipelineStageInfo, colTasks: Task[], laneKey?: string) => {
    const overWip = !laneKey && stage.wip_limit != null && colTasks.length > stage.wip_limit;
    const tone = stage.color || STAGE_TONE[stage.key];
    const isCollapsed = !laneKey && collapsedCols.has(stage.key);
    const colKey = laneKey ? `${laneKey}:${stage.key}` : stage.key;

    if (isCollapsed) {
      return (
        <section
          key={colKey}
          className={`column is-collapsed ${tone} ${dropStage === stage.key ? "is-drop-target" : ""}`}
          onClick={() => toggleCollapseCol(stage.key)}
          onDragOver={(e) => {
            if (!canEdit) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropStage !== stage.key) setDropStage(stage.key);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropStage((cur) => (cur === stage.key ? null : cur));
          }}
          onDrop={(e) => handleDrop(e, stage.key)}
          role="button"
          tabIndex={0}
          aria-label={`${stage.label} 컬럼 펼치기 (${colTasks.length}건)`}
          title={`${stage.label} 펼치기 (${colTasks.length}건 · 카드 드롭 가능)`}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggleCollapseCol(stage.key)}
        >
          <span className="dot" />
          <span className="col-collapsed-count mono">{colTasks.length}</span>
          <span className="col-collapsed-label">{stage.label}</span>
        </section>
      );
    }

    const donePartition = stage.key === "done" ? partitionDoneByMonth(colTasks, doneMode) : null;
    const shouldTruncate =
      stage.key !== "done" && !quickQuery.trim() && !expandedLongCols.has(colKey) && colTasks.length > COL_PAGE_SIZE;
    const visibleColTasks = shouldTruncate ? colTasks.slice(0, COL_PAGE_SIZE) : colTasks;

    return (
      <section
        key={colKey}
        className={`column ${tone} ${dropStage === stage.key ? "is-drop-target" : ""} ${overWip ? "is-wip-exceeded" : ""}`}
        onDragOver={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dropStage !== stage.key) setDropStage(stage.key);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropStage((cur) => (cur === stage.key ? null : cur));
        }}
        onDrop={(e) => handleDrop(e, stage.key)}
      >
        <h3 className="column-head">
          <span className="dot" />
          <span>{stage.label}</span>
          <span
            className={`count ${overWip ? "wip-over" : ""}`}
            title={stage.wip_limit ? `WIP 상한 ${stage.wip_limit}건${overWip ? " 초과" : ""}` : undefined}
          >
            {stage.wip_limit && !laneKey ? `${colTasks.length}/${stage.wip_limit}` : colTasks.length}
            {overWip && " !"}
          </span>
          {!laneKey && (
            <button
              type="button"
              className="icon-btn col-collapse-btn"
              onClick={() => toggleCollapseCol(stage.key)}
              title={`${stage.label} 컬럼 접기`}
              aria-label={`${stage.label} 컬럼 접기`}
            >
              ‹
            </button>
          )}
        </h3>

        {colTasks.length === 0 && <div className="column-empty">비어 있음</div>}

        {donePartition ? (
          <>
            {donePartition.buckets.length > 0 && (
              <div className="done-subhead">
                <span>{donePartition.expandedLabel}</span>
                <span className="mono">{donePartition.expanded.length}</span>
              </div>
            )}
            {donePartition.expanded.length === 0 && donePartition.buckets.length > 0 && (
              <div className="done-empty-note">해당 기간 완료 일감이 없습니다</div>
            )}
            {donePartition.expanded.map(renderCard)}
            {donePartition.buckets.map((bucket) => {
              const bKey = `${colKey}:${bucket.key}`;
              const open = expandedMonths.has(bKey);
              return (
                <div key={bKey} className={`month-bucket ${open ? "is-open" : ""}`}>
                  <button type="button" className="month-bucket-head" aria-expanded={open} onClick={() => toggleMonth(bKey)}>
                    <ChevronIcon size={11} className={open ? "is-open" : ""} />
                    <span className="month-bucket-label">{bucket.label}</span>
                    <span className="month-bucket-count mono">{bucket.tasks.length}건</span>
                  </button>
                  {open && <div className="month-bucket-body">{bucket.tasks.map(renderCard)}</div>}
                </div>
              );
            })}
          </>
        ) : (
          <>
            {visibleColTasks.map(renderCard)}
            {shouldTruncate && (
              <button type="button" className="col-more-btn" onClick={() => toggleLongCol(colKey)}>
                + 나머지 {colTasks.length - COL_PAGE_SIZE}건 더 보기
              </button>
            )}
            {!shouldTruncate && !quickQuery.trim() && colTasks.length > COL_PAGE_SIZE && (
              <button type="button" className="col-more-btn" onClick={() => toggleLongCol(colKey)}>
                접기 ({COL_PAGE_SIZE}건만 보기)
              </button>
            )}
          </>
        )}
      </section>
    );
  };

  return (
    <>
      <section className="tiles" aria-label="단계별 현황 빠른 필터">
        <button
          type="button"
          className={`tile fill-run ${stageGroup === "in_progress" ? "is-active" : ""}`}
          aria-pressed={stageGroup === "in_progress"}
          onClick={() => toggleStageGroup("in_progress")}
          title="클릭하여 진행 중 일감만 보기"
        >
          <span className="tile-num">{countBase("in_progress")}</span>
          <span className="tile-label">진행 중</span>
        </button>
        <button
          type="button"
          className={`tile fill-wait ${stageGroup === "review_qa" ? "is-active" : ""}`}
          aria-pressed={stageGroup === "review_qa"}
          onClick={() => toggleStageGroup("review_qa")}
          title="클릭하여 리뷰·QA 대기 일감만 보기"
        >
          <span className="tile-num">{countBase("review", "qa")}</span>
          <span className="tile-label">리뷰 · QA 대기</span>
        </button>
        <button
          type="button"
          className={`tile text-done ${stageGroup === "done" ? "is-active" : ""}`}
          aria-pressed={stageGroup === "done"}
          onClick={() => toggleStageGroup("done")}
          title="클릭하여 완료 일감만 보기"
        >
          <span className="tile-num">{countBase("done")}</span>
          <span className="tile-label">완료</span>
        </button>
        <button
          type="button"
          className={`tile ${stageGroup === "todo_backlog" ? "is-active" : ""}`}
          aria-pressed={stageGroup === "todo_backlog"}
          onClick={() => toggleStageGroup("todo_backlog")}
          title="클릭하여 백로그·할 일만 보기"
        >
          <span className="tile-num">{countBase("backlog", "todo")}</span>
          <span className="tile-label">대기 중</span>
        </button>
      </section>

      <div className="board-toolbar">
        {can("create") ? (
          <form onSubmit={create} className="board-create">
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="새 일감 제목을 입력하세요" />
            <button type="submit" className="btn btn-primary" disabled={!newTitle.trim()}>
              <PlusIcon size={11} /> 일감 등록
            </button>
          </form>
        ) : (
          <span className="board-create muted readonly-note">보기 권한만 있어 일감을 등록할 수 없습니다.</span>
        )}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <RefreshButton refreshing={refreshing} lastUpdated={lastUpdated} onClick={refresh} shortcut />
          <Link to={`/projects/${project.id}/triage`} className="btn btn-sm" title="트리아지 / 인테이크 대기열">
            트리아지{triageCount > 0 && <span className="pill tone-wait" style={{ marginLeft: 5 }}>{triageCount}</span>}
          </Link>
          <span
            className={`live-pill ${liveStatus === "connected" ? "is-live" : ""}`}
            title={liveStatus === "connected" ? "실시간 동기화 연결됨 (SSE) · 30초마다 자동 보강" : "실시간 연결 재시도 중 · 30초마다 자동 새로고침"}
          >
            <span className="live-dot" />
            {liveStatus === "connected" ? "실시간" : "연결 중"}
          </span>
          <div className="segment" role="group" aria-label="보기 방식">
            {([
              ["board", "보드"],
              ["list", "리스트"],
              ["timeline", "타임라인"],
            ] as const).map(([v, label]) => (
              <button key={v} aria-pressed={layout === v} onClick={() => setParam("view", v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* MW-16: 핵심 정리 컨트롤 바 (즉시 검색 · 완료 월별 묶음 · 그룹핑 · 밀도 · 상세 필터 토글) */}
      <div className="organize-bar">
        <div className="segment" role="group" aria-label="작업자 필터">
          {(["all", "me", "none"] as const).map((f) => (
            <button key={f} aria-pressed={assignee === f} onClick={() => setParam("assignee", f)}>
              {{ all: "전체", me: "내 일감", none: "미지정" }[f]}
            </button>
          ))}
        </div>

        <label className="quick-filter" aria-label="보드 내 빠른 검색">
          <SearchIcon size={12} />
          <input
            value={quickQuery}
            onChange={(e) => setParam("q", e.target.value)}
            placeholder="키·제목·#레이블 즉시 필터"
          />
          {quickQuery && (
            <button type="button" className="icon-btn" onClick={() => setParam("q", "")} aria-label="검색어 지우기">
              <CloseIcon size={11} />
            </button>
          )}
        </label>

        <select
          className="filter-select"
          value={doneMode}
          onChange={(e) => setParam("done", e.target.value)}
          aria-label="완료 일감 표시 방식"
          title="완료 컬럼 정리 방식"
        >
          <option value="monthly">완료: 이번 달 펼침 (이전 월 묶음)</option>
          <option value="recent7">완료: 최근 7일만 펼침</option>
          <option value="hide">완료: 모두 숨김 (진행 집중)</option>
          <option value="all">완료: 전체 펼침</option>
        </select>

        {allVersions.length > 0 && (
          <select
            className="filter-select"
            value={versionFilter}
            onChange={(e) => setParam("ver", e.target.value)}
            aria-label="버전 필터"
            title="버전별 필터"
          >
            <option value="">모든 버전</option>
            <option value="none">버전 미지정</option>
            {allVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}

        {layout !== "timeline" && (
          <select
            className="filter-select"
            value={layout === "board" ? boardGroupBy : listGroupBy}
            onChange={(e) => setParam("group", e.target.value)}
            aria-label="그룹핑 기준"
            title={layout === "board" ? "보드 스윔레인 묶기" : "리스트 섹션 묶기"}
          >
            {layout === "list" && <option value="stage">그룹: 단계별</option>}
            <option value="none">{layout === "board" ? "스윔레인: 없음" : "그룹: 없음 (평면)"}</option>
            {allVersions.length > 0 && <option value="version">그룹: 버전별</option>}
            <option value="priority">그룹: 우선순위별</option>
            <option value="assignee">그룹: 작업자별</option>
            {milestones.length > 0 && <option value="milestone">그룹: 마일스톤별</option>}
            {cycles.length > 0 && <option value="cycle">그룹: 사이클별</option>}
          </select>
        )}

        {layout !== "timeline" && (
          <button
            type="button"
            className={`btn btn-sm ${compact ? "btn-accent" : ""}`}
            aria-pressed={compact}
            onClick={toggleCompact}
            title="카드를 슬림하게 줄여 한 화면에 더 많은 일감 보기"
          >
            {compact ? "컴팩트 켜짐" : "컴팩트"}
          </button>
        )}

        <button
          type="button"
          className={`btn btn-sm ${showAdvancedFilters ? "btn-primary" : ""}`}
          aria-expanded={showAdvancedFilters}
          onClick={() => setMoreFiltersOpen((o) => !o)}
        >
          필터{advancedFilterCount > 0 && <span className="pill tone-wait" style={{ marginLeft: 4 }}>{advancedFilterCount}</span>}
        </button>

        {hasFilters && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setParams(layout === "board" ? {} : { view: layout }, { replace: true })}>
            초기화
          </button>
        )}
        {can("create") && (
          <button type="button" className="btn btn-sm" onClick={saveCurrentView}>
            + 뷰 저장
          </button>
        )}
      </div>

      {showAdvancedFilters && (
        <div className="filter-bar is-advanced">
          <select
            className="filter-select"
            value={["all", "me", "none"].includes(assignee) ? "" : assignee}
            onChange={(e) => setParam("assignee", e.target.value || "all")}
            aria-label="작업자 선택"
          >
            <option value="">작업자별…</option>
            {members.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
          <select className="filter-select" value={priority} onChange={(e) => setParam("priority", e.target.value)} aria-label="우선순위 필터">
            <option value="">모든 우선순위</option>
            {(["urgent", "high", "medium", "low"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          {allTags.length > 0 && (
            <select className="filter-select" value={tag} onChange={(e) => setParam("tag", e.target.value)} aria-label="레이블 필터">
              <option value="">모든 레이블</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          )}
          {cycles.length > 0 && (
            <select className="filter-select" value={cycleFilter} onChange={(e) => setParam("cycle", e.target.value)} aria-label="사이클 필터">
              <option value="">모든 사이클</option>
              <option value="none">사이클 미지정</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.status === "active" ? "● " : ""}
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {milestones.length > 0 && (
            <select className="filter-select" value={milestoneFilter} onChange={(e) => setParam("milestone", e.target.value)} aria-label="마일스톤 필터">
              <option value="">모든 마일스톤</option>
              <option value="none">마일스톤 미지정</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <select className="filter-select" value={dueFilter} onChange={(e) => setParam("due", e.target.value)} aria-label="마감일 필터">
            <option value="">모든 일정</option>
            <option value="overdue">마감 지남</option>
            <option value="soon">마감 임박 (2일 이내)</option>
            <option value="has_due">마감일 있음</option>
          </select>
          <select className="filter-select" value={sort} onChange={(e) => setParam("sort", e.target.value)} aria-label="정렬">
            <option value="number">번호순</option>
            <option value="priority">우선순위순</option>
            <option value="due">마감일순</option>
            <option value="updated">최신 수정순</option>
          </select>
        </div>
      )}

      {(savedViews.length > 0 || hiddenDoneCount > 0 || stageGroup) && (
        <div className="saved-views-bar">
          {stageGroup && (
            <span className="conn-chip tone-run">
              단계 필터: {{ in_progress: "진행 중", review_qa: "리뷰 · QA 대기", done: "완료", todo_backlog: "대기 중" }[stageGroup]}
              <button type="button" className="chip-del" onClick={() => setParam("sg", "")} title="필터 해제">
                ×
              </button>
            </span>
          )}
          {hiddenDoneCount > 0 && (
            <span className="conn-chip">
              완료 {hiddenDoneCount}건 숨김
              <button type="button" className="link-btn" style={{ marginLeft: 4, color: "var(--accent)", fontWeight: 600 }} onClick={() => setParam("done", "monthly")}>
                이번 달 보기
              </button>
            </span>
          )}
          {savedViews.length > 0 && <span className="muted" style={{ fontSize: 11.5 }}>저장된 뷰</span>}
          {savedViews.map((v) => (
            <span key={v.id} className="conn-chip att-chip">
              <button type="button" className="link-btn" onClick={() => applyView(v)}>
                {v.name}
              </button>
              {(v.created_by === me?.id || can("delete") || can("admin")) && (
                <button type="button" className="chip-del" title="뷰 삭제" onClick={() => removeView(v)}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {layout === "board" && (
        <div className="canvas">
          {boardSwimlanes ? (
            boardSwimlanes.length === 0 ? (
              <div className="empty">조건에 맞는 일감이 없습니다.</div>
            ) : (
              <div className="swimlanes">
                {boardSwimlanes.map((lane) => {
                  const collapsed = collapsedLanes.has(lane.key);
                  return (
                    <div key={lane.key} className={`swimlane ${lane.tone ?? ""}`}>
                      <button type="button" className="swimlane-head" aria-expanded={!collapsed} onClick={() => toggleLane(lane.key)}>
                        <ChevronIcon size={12} className={!collapsed ? "is-open" : ""} />
                        {lane.tone && <span className="dot" />}
                        <strong>{lane.label}</strong>
                        <span className="pill">{lane.tasks.length}건</span>
                      </button>
                      {!collapsed && (
                        <div className="board swimlane-board">
                          {boardStages.map((stage) =>
                            renderColumn(
                              stage,
                              lane.tasks.filter((t) => t.stage === stage.key),
                              lane.key,
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="board">
              {boardStages.map((stage) =>
                renderColumn(
                  stage,
                  visible.filter((t) => t.stage === stage.key),
                ),
              )}
            </div>
          )}
        </div>
      )}

      {layout === "list" && (
        <TaskListView
          projectId={project.id}
          projectKey={project.key}
          tasks={visible}
          stages={visibleStages}
          usersById={usersById}
          milestones={milestones}
          cycles={cycles}
          groupBy={listGroupBy}
          doneMode={doneMode}
          compact={compact}
          canEdit={canEdit}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAllVisible}
          onMoveStage={moveStage}
        />
      )}

      {layout === "timeline" && (
        <TaskTimelineView
          projectId={project.id}
          projectKey={project.key}
          tasks={doneMode === "hide" && stageGroup !== "done" ? visible.filter((t) => t.stage !== "done") : visible}
          canEdit={canEdit}
          onPatchTask={patchTask}
        />
      )}

      {selectedIds.size > 0 && canEdit && (
        <div className="bulk-bar" role="region" aria-label="일괄 편집">
          <strong className="mono">{selectedIds.size}건 선택</strong>
          <select
            className="filter-select"
            value=""
            disabled={bulkBusy}
            aria-label="일괄 단계 변경"
            onChange={(e) => e.target.value && runBulk({ stage: e.target.value as PipelineStage })}
          >
            <option value="">단계 이동…</option>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            className="filter-select"
            value=""
            disabled={bulkBusy}
            aria-label="일괄 우선순위 변경"
            onChange={(e) => e.target.value && runBulk({ priority: e.target.value as Priority })}
          >
            <option value="">우선순위…</option>
            {(["urgent", "high", "medium", "low"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <select
            className="filter-select"
            value=""
            disabled={bulkBusy}
            aria-label="일괄 작업자 배정"
            onChange={(e) => {
              if (!e.target.value) return;
              runBulk({ assignee_id: e.target.value === "__none__" ? null : e.target.value });
            }}
          >
            <option value="">작업자 배정…</option>
            <option value="__none__">미지정으로 해제</option>
            {members.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
          {cycles.length > 0 && (
            <select
              className="filter-select"
              value=""
              disabled={bulkBusy}
              aria-label="일괄 사이클 배정"
              onChange={(e) => {
                if (!e.target.value) return;
                runBulk({ cycle_id: e.target.value === "__none__" ? null : e.target.value });
              }}
            >
              <option value="">사이클…</option>
              <option value="__none__">사이클 해제</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <form
            className="row"
            style={{ gap: 4 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (bulkVersion.trim()) runBulk({ version: bulkVersion.trim() });
            }}
          >
            <input
              className="bulk-tag-input mono"
              list="mw-bulk-versions"
              value={bulkVersion}
              maxLength={40}
              onChange={(e) => setBulkVersion(e.target.value)}
              placeholder="버전 (v0.1.0)"
              aria-label="일괄 버전 지정"
            />
            {allVersions.length > 0 && (
              <datalist id="mw-bulk-versions">
                {allVersions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            )}
          </form>
          <form
            className="row"
            style={{ gap: 4 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (bulkTag.trim()) runBulk({ add_tags: [bulkTag.trim()] });
            }}
          >
            <input
              className="bulk-tag-input"
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder="+ 레이블"
              aria-label="일괄 레이블 추가"
            />
          </form>
          {can("delete") && (
            <button type="button" className="btn btn-sm btn-danger" disabled={bulkBusy} onClick={() => runBulk({ delete: true })}>
              삭제
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelectedIds(new Set())}>
            해제
          </button>
        </div>
      )}

      <Outlet context={context} />
    </>
  );
}
