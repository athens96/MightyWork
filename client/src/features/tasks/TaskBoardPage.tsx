import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { Link, Outlet, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { cyclesApi, membersApi, milestonesApi, pipelineApi, tasksApi, triageApi, usersApi, viewsApi } from "../../api";
import { can as canDo } from "../../lib/permissions";
import { useAuth } from "../../auth/AuthContext";
import { PlusIcon } from "../../components/icons";
import { TASK_CREATED_EVENT } from "../../components/QuickCreateModal";
import { RefreshButton } from "../../components/RefreshButton";
import { PROJECT_EVENT, subscribeSSE, type ProjectEventDetail, type SSEStatus } from "../../lib/sse";
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

/** 프로젝트 일감 화면: 보드 / 리스트 / 타임라인 전환 + 다중 필터·정렬 + 저장된 뷰 */
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
  const [bulkBusy, setBulkBusy] = useState(false);

  const layout = (params.get("view") as ViewLayout) || "board";
  const assignee = params.get("assignee") || "all";
  const priority = params.get("priority") || "";
  const tag = params.get("tag") || "";
  const dueFilter = params.get("due") || "";
  const cycleFilter = params.get("cycle") || "";
  const milestoneFilter = params.get("milestone") || "";
  const sort = (params.get("sort") as SortKey) || "number";

  const setParam = (key: string, val: string) => {
    const next = new URLSearchParams(params);
    if (!val || (key === "assignee" && val === "all") || (key === "view" && val === "board") || (key === "sort" && val === "number")) {
      next.delete(key);
    } else {
      next.set(key, val);
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

  const visible = useMemo(() => {
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
  }, [tasks, assignee, priority, tag, dueFilter, cycleFilter, milestoneFilter, sort, me?.id]);

  const count = (...s: PipelineStage[]) => visible.filter((t) => s.includes(t.stage)).length;
  const hasFilters = assignee !== "all" || !!priority || !!tag || !!dueFilter || !!cycleFilter || !!milestoneFilter || sort !== "number";

  const visibleStages = useMemo(() => {
    const active = stages.filter((s) => !s.hidden);
    return active.length > 0 ? active : stages;
  }, [stages]);

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
    const name = prompt("현재 뷰 이름 (예: 긴급 버그, 내 이번주 일감)");
    if (!name?.trim()) return;
    const filters: Record<string, string> = {};
    if (assignee !== "all") filters.assignee = assignee;
    if (priority) filters.priority = priority;
    if (tag) filters.tag = tag;
    if (dueFilter) filters.due = dueFilter;
    if (cycleFilter) filters.cycle = cycleFilter;
    if (milestoneFilter) filters.milestone = milestoneFilter;
    if (sort !== "number") filters.sort = sort;
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

  const toggleAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedIds(checked ? new Set(visible.map((t) => t.id)) : new Set());
    },
    [visible],
  );

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
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <>
      <section className="tiles">
        <div className="tile fill-run">
          <span className="tile-num">{count("in_progress")}</span>
          <span className="tile-label">진행 중</span>
        </div>
        <div className="tile fill-wait">
          <span className="tile-num">{count("review", "qa")}</span>
          <span className="tile-label">리뷰 · QA 대기</span>
        </div>
        <div className="tile text-done">
          <span className="tile-num">{count("done")}</span>
          <span className="tile-label">완료</span>
        </div>
        <div className="tile">
          <span className="tile-num">{count("backlog", "todo")}</span>
          <span className="tile-label">대기 중</span>
        </div>
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

      <div className="filter-bar">
        <div className="segment" role="group" aria-label="작업자 필터">
          {(["all", "me", "none"] as const).map((f) => (
            <button key={f} aria-pressed={assignee === f} onClick={() => setParam("assignee", f)}>
              {{ all: "전체", me: "내 일감", none: "미지정" }[f]}
            </button>
          ))}
        </div>
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

      {savedViews.length > 0 && (
        <div className="saved-views-bar">
          <span className="muted" style={{ fontSize: 11.5 }}>저장된 뷰</span>
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
          <div className="board">
            {visibleStages.map((stage) => {
              const items = visible.filter((t) => t.stage === stage.key);
              const overWip = stage.wip_limit != null && items.length > stage.wip_limit;
              const tone = stage.color || STAGE_TONE[stage.key];
              return (
                <section
                  key={stage.key}
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
                    {stage.label}
                    <span
                      className={`count ${overWip ? "wip-over" : ""}`}
                      title={stage.wip_limit ? `WIP 상한 ${stage.wip_limit}건${overWip ? " 초과" : ""}` : undefined}
                    >
                      {stage.wip_limit ? `${items.length}/${stage.wip_limit}` : items.length}
                      {overWip && " !"}
                    </span>
                  </h3>
                  {items.length === 0 && <div className="column-empty">비어 있음</div>}
                  {items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      taskKey={`${project.key}-${task.number}`}
                      href={`/projects/${project.id}/tasks/${task.id}`}
                      assignee={task.assignee_id ? usersById.get(task.assignee_id) : undefined}
                      stages={stages}
                      selected={task.id === openTaskId}
                      checked={selectedIds.has(task.id)}
                      onToggleCheck={canEdit ? toggleSelect : undefined}
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
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {layout === "list" && (
        <TaskListView
          projectId={project.id}
          projectKey={project.key}
          tasks={visible}
          stages={stages}
          usersById={usersById}
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
          tasks={visible}
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
