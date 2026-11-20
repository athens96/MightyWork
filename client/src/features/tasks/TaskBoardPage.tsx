import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { Outlet, useMatch, useNavigate } from "react-router-dom";
import { membersApi, pipelineApi, tasksApi, usersApi } from "../../api";
import { can as canDo } from "../../lib/permissions";
import { useAuth } from "../../auth/AuthContext";
import { PlusIcon } from "../../components/icons";
import type { Permission, PipelineStage, PipelineStageInfo, Task, User } from "../../types";
import { useCurrentProject } from "../projects/ProjectLayout";
import type { BoardContext } from "./boardContext";
import { TaskCard } from "./TaskCard";
import { STAGE_TONE } from "./tones";

// 상세 패널(마크다운 렌더러 포함)은 열 때만 로드
export const TaskDetailPanel = lazy(() => import("./TaskDetailPanel").then((m) => ({ default: m.TaskDetailPanel })));
export function TaskDetailRoute() {
  return (
    <Suspense fallback={null}>
      <TaskDetailPanel />
    </Suspense>
  );
}

type AssigneeFilter = "all" | "me" | "none" | string;

/** 프로젝트의 파이프라인 보드: 상태 타일 + 점 격자 캔버스 위 단계별 컬럼 (+ 상세 패널 중첩 라우트) */
export function TaskBoardPage() {
  const project = useCurrentProject();
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const openTaskId = useMatch("/projects/:projectId/tasks/:taskId")?.params.taskId;
  const [stages, setStages] = useState<PipelineStageInfo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<AssigneeFilter>("all");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<PipelineStage | null>(null);

  const reload = useCallback(async () => {
    const [p, t, u, m] = await Promise.all([pipelineApi.get(), tasksApi.list(project.id), usersApi.listByProject(project.id), membersApi.list(project.id)]);
    setStages(p);
    setTasks(t);
    setUsers(u);
    setMembers(m.flatMap((x) => (x.user ? [x.user] : [])));
  }, [project.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const task = await tasksApi.create(project.id, { title: newTitle.trim() });
    setTasks((prev) => [...prev, task]);
    setNewTitle("");
    navigate(`/projects/${project.id}/tasks/${task.id}`); // 만든 뒤 바로 상세 입력
  };

  const onCreated = useCallback((task: Task) => setTasks((prev) => [...prev, task]), []);
  const onChanged = useCallback((task: Task) => setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t))), []);
  const onDeleted = useCallback((id: string) => setTasks((prev) => prev.filter((t) => t.id !== id)), []);

  const visible = tasks.filter((t) =>
    filter === "all" ? true : filter === "me" ? t.assignee_id === me?.id : filter === "none" ? !t.assignee_id : t.assignee_id === filter,
  );
  const count = (...s: PipelineStage[]) => visible.filter((t) => s.includes(t.stage)).length;

  const can = (perm: Permission) => canDo(project, perm);
  const canEdit = can("edit");
  const context: BoardContext = { project, tasks, stages, users, members, can, onCreated, onChanged, onDeleted };

  const moveStage = async (taskId: string, target: PipelineStage) => {
    const current = tasks.find((t) => t.id === taskId);
    if (!current || current.stage === target || !canEdit) return;
    // 낙관적 반영 후 서버 응답으로 확정, 실패 시 원복
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, stage: target } : t)));
    try {
      const updated = await tasksApi.update(project.id, taskId, { stage: target });
      onChanged(updated);
    } catch {
      onChanged(current);
    }
  };

  const handleDrop = (e: DragEvent, target: PipelineStage) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain") || draggingId;
    setDropStage(null);
    setDraggingId(null);
    if (taskId) moveStage(taskId, target);
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
        <div className="segment" role="group" aria-label="작업자 필터">
          {(["all", "me", "none"] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {{ all: "전체", me: "내 일감", none: "미지정" }[f]}
            </button>
          ))}
        </div>
        <select
          className="filter-select"
          value={["all", "me", "none"].includes(filter) ? "" : filter}
          onChange={(e) => setFilter(e.target.value || "all")}
          aria-label="작업자 선택"
        >
          <option value="">작업자별…</option>
          {members.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </select>
      </div>

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

      <Outlet context={context} />
    </>
  );
}
