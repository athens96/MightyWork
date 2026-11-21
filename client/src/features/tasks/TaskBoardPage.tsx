import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { Outlet, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { membersApi, pipelineApi, tasksApi, usersApi, viewsApi } from "../../api";
import { can as canDo } from "../../lib/permissions";
import { useAuth } from "../../auth/AuthContext";
import { PlusIcon } from "../../components/icons";
import { TASK_CREATED_EVENT } from "../../components/QuickCreateModal";
import { PROJECT_EVENT, subscribeSSE, type ProjectEventDetail, type SSEStatus } from "../../lib/sse";
import { dueState } from "../../lib/time";
import type { Permission, PipelineStage, PipelineStageInfo, Priority, SavedView, Task, TaskUpdate, User } from "../../types";
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
  const [newTitle, setNewTitle] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<PipelineStage | null>(null);
  const [liveStatus, setLiveStatus] = useState<SSEStatus>("reconnecting");

  const layout = (params.get("view") as ViewLayout) || "board";
  const assignee = params.get("assignee") || "all";
  const priority = params.get("priority") || "";
  const tag = params.get("tag") || "";
  const dueFilter = params.get("due") || "";
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
    const [p, t, u, m, v] = await Promise.all([
      pipelineApi.get(),
      tasksApi.list(project.id),
      usersApi.listByProject(project.id),
      membersApi.list(project.id),
      viewsApi.list(project.id).catch(() => [] as SavedView[]),
    ]);
    setStages(p);
    setTasks(t);
    setUsers(u);
    setMembers(m.flatMap((x) => (x.user ? [x.user] : [])));
    setSavedViews(v);
  }, [project.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onQuick = (e: Event) => {
      const created = (e as CustomEvent<Task>).detail;
      if (created?.project_id === project.id) {
        setTasks((prev) => (prev.some((x) => x.id === created.id) ? prev : [...prev, created]));
      }
    };
    window.addEventListener(TASK_CREATED_EVENT, onQuick);
    return () => window.removeEventListener(TASK_CREATED_EVENT, onQuick);
  }, [project.id]);

  // MW-5: SSE 실시간 프로젝트 스트림 구독 (보드·상세·알림 자동 갱신)
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
        if (msg.event.startsWith("task.") || msg.event.startsWith("comment.") || msg.event === "github.linked") {
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            tasksApi.list(project.id).then(setTasks, () => {});
          }, 150);
        }
      },
      setLiveStatus,
    );
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      stop();
    };
  }, [project.id]);

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
  }, [tasks, assignee, priority, tag, dueFilter, sort, me?.id]);

  const count = (...s: PipelineStage[]) => visible.filter((t) => s.includes(t.stage)).length;
  const hasFilters = assignee !== "all" || !!priority || !!tag || !!dueFilter || sort !== "number";

  const can = (perm: Permission) => canDo(project, perm);
  const canEdit = can("edit");
  const context: BoardContext = { project, tasks, stages, users, members, can, onCreated, onChanged, onDeleted };

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
        <div className="row" style={{ gap: 8 }}>
          <span
            className={`live-pill ${liveStatus === "connected" ? "is-live" : ""}`}
            title={liveStatus === "connected" ? "실시간 동기화 연결됨 (SSE)" : "실시간 연결 재시도 중"}
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
            {stages.map((stage) => {
              const items = visible.filter((t) => t.stage === stage.key);
              return (
                <section
                  key={stage.key}
                  className={`column ${STAGE_TONE[stage.key]} ${dropStage === stage.key ? "is-drop-target" : ""}`}
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
                    <span className="count">{items.length}</span>
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

      <Outlet context={context} />
    </>
  );
}
