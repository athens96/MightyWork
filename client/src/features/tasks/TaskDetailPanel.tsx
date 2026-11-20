import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { commentsApi, tasksApi } from "../../api";
import { ApiError } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { CloseIcon, DocIcon, EditIcon, LinkIcon } from "../../components/icons";
import { useLinkResolver } from "../../lib/useLinkResolver";
import { Markdown } from "../../components/Markdown";
import type { Comment, Task, TaskActivity, TaskUpdate, WikiPageSummary } from "../../types";
import { useBoard } from "./boardContext";
import { TaskChecklist } from "./TaskChecklist";
import { TaskProperties } from "./TaskProperties";
import { TaskTimeline } from "./TaskTimeline";

/** 일감 상세 — 오른쪽에서 열리는 패널 (/projects/:pid/tasks/:taskId) */
export function TaskDetailPanel() {
  const { project, tasks, stages, users, members, can, onChanged, onDeleted } = useBoard();
  const editable = can("edit");
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const [task, setTask] = useState<Task | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState<string | null>(null); // null = 보기 모드
  const [wikiRefs, setWikiRefs] = useState<WikiPageSummary[]>([]);
  const resolver = useLinkResolver(project, { tasks });

  const close = useCallback(() => navigate(`/projects/${project.id}/tasks`), [navigate, project.id]);
  const refreshActivity = useCallback(() => tasksApi.activity(project.id, taskId).then(setActivity), [project.id, taskId]);

  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setNotFound(false);
    setDesc(null);
    setError(null);
    Promise.all([
      tasksApi.get(project.id, taskId),
      commentsApi.list(project.id, taskId),
      tasksApi.activity(project.id, taskId),
      tasksApi.wikiRefs(project.id, taskId),
    ])
      .then(([t, c, a, w]) => {
        if (cancelled) return;
        setTask(t);
        setTitle(t.title);
        setComments(c);
        setActivity(a);
        setWikiRefs(w);
      })
      .catch(() => !cancelled && setNotFound(true));
    return () => {
      cancelled = true;
    };
  }, [project.id, taskId]);

  // 보드 카드에서 단계를 바꾼 경우 등 보드 쪽 최신값 반영
  const boardTask = tasks.find((t) => t.id === taskId);
  useEffect(() => {
    if (boardTask && task && boardTask.updated_at > task.updated_at) {
      setTask(boardTask);
      refreshActivity();
    }
    // 보드 쪽 updated_at 이 바뀔 때만 반응
  }, [boardTask?.updated_at]);

  // Esc 로 닫기 (입력 중이 아닐 때)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select");
      if (e.key === "Escape" && !typing) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const patch = async (body: TaskUpdate) => {
    if (!task) return;
    setError(null);
    try {
      const updated = await tasksApi.update(project.id, task.id, body);
      setTask(updated);
      onChanged(updated);
      refreshActivity();
    } catch (e) {
      const dates = e instanceof ApiError && e.status === 422 && JSON.stringify(e.detail).includes("start_date");
      setError(dates ? "시작일은 종료일보다 늦을 수 없습니다." : "저장하지 못했습니다. 입력값을 확인하세요.");
    }
  };

  const syncCount = (next: Comment[]) => {
    setComments(next);
    if (task) onChanged({ ...task, comment_count: next.length });
  };

  const remove = async () => {
    if (!task || !confirm(`"${task.title}" 일감을 삭제할까요?\n덧글과 이력도 함께 삭제됩니다.`)) return;
    await tasksApi.remove(project.id, task.id);
    onDeleted(task.id);
    close();
  };

  const commitTitle = () => {
    const t = title.trim();
    if (task && t && t !== task.title) patch({ title: t });
    else if (task) setTitle(task.title);
  };

  const saveDesc = async () => {
    if (desc === null) return;
    await patch({ description: desc });
    setDesc(null);
  };

  const taskKey = task ? `${project.key}-${task.number}` : "";

  return (
    <>
      <div className="sheet-backdrop" onClick={close} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={taskKey || "일감"}>
        <header className="sheet-head">
          <span className="key-badge">{taskKey || "…"}</span>
          <span className="sheet-title">{task?.title}</span>
          <button
            className="icon-btn"
            title="링크 복사"
            onClick={() => navigator.clipboard?.writeText(window.location.href)}
          >
            <LinkIcon size={13} />
          </button>
          <button className="icon-btn" onClick={close} title="닫기 (Esc)">
            <CloseIcon size={13} />
          </button>
        </header>

        {notFound && <div className="empty">일감을 찾을 수 없습니다.</div>}
        {!task && !notFound && <div className="empty">불러오는 중…</div>}

        {task && (
          <div className="sheet-body">
            <div className="detail-main">
              {error && <div className="alert tone-err">{error}</div>}

              <input
                className="detail-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commitTitle}
                readOnly={!editable}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
                aria-label="제목"
              />

              <section className="detail-section">
                <header className="section-head">
                  <h3>설명</h3>
                  <span className="spacer" />
                  {desc === null && editable && (
                    <button className="btn btn-sm" onClick={() => setDesc(task.description)}>
                      <EditIcon size={11} /> 편집
                    </button>
                  )}
                </header>
                {desc === null ? (
                  task.description ? (
                    <Markdown links={resolver}>{task.description}</Markdown>
                  ) : editable ? (
                    <button className="placeholder-block" onClick={() => setDesc("")}>
                      설명을 추가하세요 (Markdown 지원)
                    </button>
                  ) : (
                    <p className="muted">설명 없음</p>
                  )
                ) : (
                  <div className="desc-editor">
                    <div className="editor-split compact">
                      <textarea
                        autoFocus
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                            e.preventDefault();
                            saveDesc();
                          }
                        }}
                        placeholder="배경, 목표, 완료 조건 등을 Markdown으로 작성하세요"
                      />
                      <div className="editor-preview">
                        <div className="editor-preview-label">미리보기</div>
                        {desc ? <Markdown links={resolver}>{desc}</Markdown> : <p className="muted">입력하면 여기에 렌더링됩니다.</p>}
                      </div>
                    </div>
                    <div className="editor-foot">
                      <span className="editor-hint">
                        <code>[[위키 제목]]</code> <code>{project.key}-12</code> 로 연결 · 저장 ⌘S
                      </span>
                      <button className="btn btn-ghost" onClick={() => setDesc(null)}>
                        취소
                      </button>
                      <button className="btn btn-primary" onClick={saveDesc}>
                        저장
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <TaskChecklist items={task.checklist} readOnly={!editable} onChange={(checklist) => patch({ checklist })} />

              {wikiRefs.length > 0 && (
                <section className="detail-section">
                  <header className="section-head">
                    <h3>이 일감을 언급한 위키 {wikiRefs.length}</h3>
                  </header>
                  <div className="conn-group">
                    {wikiRefs.map((p) => (
                      <Link key={p.id} to={`/projects/${project.id}/wiki/${p.id}`} className="conn-chip">
                        <DocIcon size={11} /> {p.title}
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              <TaskTimeline
                links={resolver}
                comments={comments}
                activity={activity}
                users={users}
                stages={stages}
                meId={me?.id}
                canComment={can("create")}
                canModerate={can("admin")}
                onAdd={async (body) => syncCount([...comments, await commentsApi.create(project.id, task.id, body)])}
                onEdit={async (id, body) => {
                  const updated = await commentsApi.update(project.id, task.id, id, body);
                  setComments(comments.map((c) => (c.id === id ? updated : c)));
                }}
                onRemove={async (id) => {
                  await commentsApi.remove(project.id, task.id, id);
                  syncCount(comments.filter((c) => c.id !== id));
                }}
              />
            </div>

            <TaskProperties
              key={task.id}
              task={task}
              stages={stages}
              users={users}
              assignees={members}
              readOnly={!editable}
              canDelete={can("delete")}
              onPatch={patch}
              onDelete={remove}
            />
          </div>
        )}
      </section>
    </>
  );
}
