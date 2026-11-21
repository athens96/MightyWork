import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { attachmentsApi, commentsApi, githubApi, tasksApi, wikiApi } from "../../api";
import { ApiError, saveBlob } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { EditorSuggestBar, useEditorSuggest } from "../../components/EditorSuggest";
import { CloseIcon, DocIcon, EditIcon, LinkIcon, PaperclipIcon } from "../../components/icons";
import { makeBranchName } from "../../lib/branchName";
import { extractImageFile, insertUploadedImage } from "../../lib/editorUpload";
import { PROJECT_EVENT, type ProjectEventDetail } from "../../lib/sse";
import { useLinkResolver } from "../../lib/useLinkResolver";
import { Markdown } from "../../components/Markdown";
import type { Attachment, Comment, GitHubLink, Task, TaskActivity, TaskLink, TaskLinkKind, TaskUpdate, WikiPageSummary } from "../../types";
import { useBoard } from "./boardContext";
import { TaskChecklist } from "./TaskChecklist";
import { TaskProperties } from "./TaskProperties";
import { TaskTimeline } from "./TaskTimeline";
import { STAGE_TONE, TASK_LINK_LABEL } from "./tones";

/** 일감 상세 — 오른쪽에서 열리는 패널 (/projects/:pid/tasks/:taskId) */
export function TaskDetailPanel() {
  const { project, tasks, stages, cycles, users, members, can, onCreated, onChanged, onDeleted } = useBoard();
  const editable = can("edit");
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const [task, setTask] = useState<Task | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [taskLinks, setTaskLinks] = useState<TaskLink[]>([]);
  const [wikiRefs, setWikiRefs] = useState<WikiPageSummary[]>([]);
  const [wikiLinks, setWikiLinks] = useState<{ title: string; page_id: string | null }[]>([]);
  const [githubLinks, setGithubLinks] = useState<GitHubLink[]>([]);
  const [branchCopied, setBranchCopied] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState<string | null>(null); // null = 보기 모드
  const [descCursor, setDescCursor] = useState(0);
  const [newSubTitle, setNewSubTitle] = useState("");
  const [linkKind, setLinkKind] = useState<TaskLinkKind>("relates_to");
  const [linkTarget, setLinkTarget] = useState("");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const attInput = useRef<HTMLInputElement>(null);
  const resolver = useLinkResolver(project, { tasks, pages });
  const descSuggest = useEditorSuggest(desc ?? "", descCursor, pages, members);

  const close = useCallback(() => navigate(`/projects/${project.id}/tasks`), [navigate, project.id]);
  const refreshActivity = useCallback(() => tasksApi.activity(project.id, taskId).then(setActivity), [project.id, taskId]);

  useEffect(() => {
    wikiApi.list(project.id).then(setPages, () => {});
  }, [project.id]);

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
      tasksApi.wikiLinks(project.id, taskId),
      tasksApi.subtasks(project.id, taskId),
      tasksApi.links(project.id, taskId),
      attachmentsApi.list(project.id, { task_id: taskId }),
      githubApi.taskLinks(project.id, taskId).catch(() => [] as GitHubLink[]),
    ])
      .then(([t, c, a, w, wl, subs, ls, atts, gh]) => {
        if (cancelled) return;
        setTask(t);
        setTitle(t.title);
        setComments(c);
        setActivity(a);
        setWikiRefs(w);
        setWikiLinks(wl);
        setSubtasks(subs);
        setTaskLinks(ls);
        setAttachments(atts);
        setGithubLinks(gh);
      })
      .catch(() => !cancelled && setNotFound(true));
    return () => {
      cancelled = true;
    };
  }, [project.id, taskId]);

  const boardTask = tasks.find((t) => t.id === taskId);
  useEffect(() => {
    if (boardTask && task && boardTask.updated_at > task.updated_at) {
      setTask(boardTask);
      setTitle(boardTask.title);
      refreshActivity();
    }
  }, [boardTask?.updated_at]);

  // MW-5: 현재 열려 있는 일감의 덧글·GitHub·이력 실시간 갱신
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<ProjectEventDetail>).detail;
      if (!detail || detail.projectId !== project.id) return;
      if (detail.data.task_id !== taskId) return;
      if (detail.event.startsWith("comment.")) {
        commentsApi.list(project.id, taskId).then(setComments, () => {});
      } else if (detail.event === "github.linked") {
        githubApi.taskLinks(project.id, taskId).then(setGithubLinks, () => {});
      } else if (detail.event === "task.updated") {
        tasksApi.get(project.id, taskId).then((t) => {
          setTask(t);
          setTitle(t.title);
        }, () => {});
        refreshActivity();
      }
    };
    window.addEventListener(PROJECT_EVENT, onEvent);
    return () => window.removeEventListener(PROJECT_EVENT, onEvent);
  }, [project.id, taskId, refreshActivity]);

  // Esc 닫기 + Linear 스타일 상세 패널 단축키 (1~4 우선순위, A 내게 배정, S 다음 단계)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']");
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        close();
        return;
      }
      if (!editable || !task) return;
      const prioByKey: Record<string, Task["priority"]> = { "1": "urgent", "2": "high", "3": "medium", "4": "low" };
      if (prioByKey[e.key]) {
        e.preventDefault();
        patch({ priority: prioByKey[e.key] });
      } else if (e.key.toLowerCase() === "a" && me) {
        e.preventDefault();
        patch({ assignee_id: task.assignee_id === me.id ? null : me.id });
      } else if (e.key.toLowerCase() === "s" && stages.length > 0) {
        e.preventDefault();
        const idx = stages.findIndex((s) => s.key === task.stage);
        const next = stages[(idx + 1) % stages.length];
        if (next) patch({ stage: next.key });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, editable, task, me, stages]);

  const patch = async (body: TaskUpdate) => {
    if (!task) return;
    setError(null);
    try {
      const updated = await tasksApi.update(project.id, task.id, body);
      setTask(updated);
      onChanged(updated);
      refreshActivity();
      if (body.description !== undefined) {
        tasksApi.wikiLinks(project.id, task.id).then(setWikiLinks, () => {});
      }
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

  const addSubtask = async (e: FormEvent) => {
    e.preventDefault();
    if (!task || !newSubTitle.trim()) return;
    const created = await tasksApi.create(project.id, { title: newSubTitle.trim(), parent_id: task.id });
    setSubtasks((prev) => [...prev, created]);
    onCreated(created);
    const updatedParent = { ...task, subtask_count: task.subtask_count + 1 };
    setTask(updatedParent);
    onChanged(updatedParent);
    setNewSubTitle("");
  };

  const addTaskLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!task || !linkTarget) return;
    setError(null);
    try {
      const created = await tasksApi.addLink(project.id, task.id, linkTarget, linkKind);
      setTaskLinks((prev) => [...prev, created]);
      setLinkTarget("");
    } catch (err) {
      setError(err instanceof ApiError ? String(err.detail) : "일감 연결에 실패했습니다.");
    }
  };

  const removeTaskLink = async (linkId: string) => {
    if (!task) return;
    await tasksApi.removeLink(project.id, task.id, linkId);
    setTaskLinks((prev) => prev.filter((l) => l.id !== linkId));
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
  const parentTask = task?.parent_id ? tasks.find((t) => t.id === task.parent_id) : undefined;
  const linkCandidates = tasks.filter((t) => t.id !== task?.id);

  return (
    <>
      <div className="sheet-backdrop" onClick={close} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={taskKey || "일감"}>
        <header className="sheet-head">
          <span className="key-badge">{taskKey || "…"}</span>
          <span className="sheet-title">{task?.title}</span>
          {task && (
            <button
              className="btn btn-sm btn-ghost"
              title="Git 브랜치명 복사"
              onClick={() => {
                navigator.clipboard?.writeText(makeBranchName(project.key, task.number, task.title, task.tags));
                setBranchCopied(true);
                setTimeout(() => setBranchCopied(false), 1500);
              }}
            >
              {branchCopied ? "브랜치 복사됨" : "브랜치 복사"}
            </button>
          )}
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
              {parentTask && (
                <div className="parent-crumb">
                  <span className="muted">상위 일감</span>
                  <Link to={`/projects/${project.id}/tasks/${parentTask.id}`} className="conn-chip">
                    {project.key}-{parentTask.number} {parentTask.title}
                  </Link>
                </div>
              )}

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
                      설명을 추가하세요 (Markdown · [[위키]] · @멘션 지원)
                    </button>
                  ) : (
                    <p className="muted">설명 없음</p>
                  )
                ) : (
                  <div className="desc-editor">
                    <EditorSuggestBar
                      match={descSuggest.match}
                      items={descSuggest.items}
                      index={descSuggest.index}
                      value={desc}
                      onPick={(next, pos) => {
                        setDesc(next);
                        setDescCursor(pos);
                        requestAnimationFrame(() => descRef.current?.setSelectionRange(pos, pos));
                      }}
                    />
                    <div className="editor-split compact">
                      <textarea
                        ref={descRef}
                        autoFocus
                        value={desc}
                        onChange={(e) => {
                          setDesc(e.target.value);
                          setDescCursor(e.target.selectionStart ?? e.target.value.length);
                        }}
                        onSelect={(e) => setDescCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
                        onPaste={(e) => {
                          const img = extractImageFile(e.clipboardData);
                          if (img && can("create")) {
                            e.preventDefault();
                            insertUploadedImage(project.id, img, desc, descRef.current, setDesc);
                          }
                        }}
                        onDrop={(e) => {
                          const img = extractImageFile(e.dataTransfer);
                          if (img && can("create")) {
                            e.preventDefault();
                            insertUploadedImage(project.id, img, desc, descRef.current, setDesc);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (
                            descSuggest.handleKeyDown(e, (next, pos) => {
                              setDesc(next);
                              setDescCursor(pos);
                              requestAnimationFrame(() => descRef.current?.setSelectionRange(pos, pos));
                            })
                          ) {
                            return;
                          }
                          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                            e.preventDefault();
                            saveDesc();
                          }
                        }}
                        placeholder="배경, 목표, 완료 조건 등을 Markdown으로 작성하세요 ([[위키]], @멘션, 이미지 붙여넣기 지원)"
                      />
                      <div className="editor-preview">
                        <div className="editor-preview-label">미리보기</div>
                        {desc ? <Markdown links={resolver}>{desc}</Markdown> : <p className="muted">입력하면 여기에 렌더링됩니다.</p>}
                      </div>
                    </div>
                    <div className="editor-foot">
                      <span className="editor-hint">
                        <code>[[위키 제목]]</code> <code>@멘션</code> <code>{project.key}-12</code> · 저장 ⌘S
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

              {/* 하위 일감 */}
              <section className="detail-section">
                <header className="section-head">
                  <h3>하위 일감 {subtasks.length > 0 && `${subtasks.filter((s) => s.stage === "done").length}/${subtasks.length}`}</h3>
                </header>
                {subtasks.length > 0 && (
                  <div className="subtask-list">
                    {subtasks.map((s) => (
                      <Link key={s.id} to={`/projects/${project.id}/tasks/${s.id}`} className={`conn-chip task ${STAGE_TONE[s.stage]}`}>
                        <span className="dot" /> {project.key}-{s.number} {s.title}
                      </Link>
                    ))}
                  </div>
                )}
                {can("create") && (
                  <form className="inline-add" onSubmit={addSubtask}>
                    <input value={newSubTitle} onChange={(e) => setNewSubTitle(e.target.value)} placeholder="하위 일감 제목 추가…" />
                    <button type="submit" className="btn btn-sm" disabled={!newSubTitle.trim()}>
                      추가
                    </button>
                  </form>
                )}
              </section>

              {/* 일감 간 링크 */}
              <section className="detail-section">
                <header className="section-head">
                  <h3>연결된 일감 {taskLinks.length > 0 && taskLinks.length}</h3>
                </header>
                {taskLinks.length > 0 && (
                  <div className="conn-group">
                    {taskLinks.map((l) => (
                      <span key={l.id} className={`conn-chip task ${STAGE_TONE[l.stage]}`}>
                        <span className="link-kind-tag">{TASK_LINK_LABEL[l.kind] ?? l.kind}</span>
                        <Link to={`/projects/${project.id}/tasks/${l.task_id}`}>
                          {project.key}-{l.number} {l.title}
                        </Link>
                        {editable && (
                          <button type="button" className="chip-del" title="연결 해제" onClick={() => removeTaskLink(l.id)}>
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {editable && linkCandidates.length > 0 && (
                  <form className="inline-add" onSubmit={addTaskLink}>
                    <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as TaskLinkKind)} aria-label="관계 종류">
                      <option value="relates_to">관련됨</option>
                      <option value="blocks">차단함</option>
                      <option value="duplicates">중복함</option>
                    </select>
                    <select value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)} aria-label="대상 일감">
                      <option value="">일감 선택…</option>
                      {linkCandidates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {project.key}-{t.number} {t.title}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn btn-sm" disabled={!linkTarget}>
                      연결
                    </button>
                  </form>
                )}
              </section>

              {/* 양방향 일감↔위키 연결 */}
              {(wikiLinks.length > 0 || wikiRefs.length > 0) && (
                <section className="detail-section">
                  <header className="section-head">
                    <h3>연결된 위키 {wikiLinks.length + wikiRefs.length}</h3>
                  </header>
                  <div className="conn-group">
                    {wikiLinks.map((w) =>
                      w.page_id ? (
                        <Link key={`out-${w.title}`} to={`/projects/${project.id}/wiki/${w.page_id}`} className="conn-chip">
                          <DocIcon size={11} /> → {w.title}
                        </Link>
                      ) : (
                        <span key={`out-${w.title}`} className="conn-chip missing">
                          → {w.title}
                        </span>
                      ),
                    )}
                    {wikiRefs.map((p) => (
                      <Link key={`in-${p.id}`} to={`/projects/${project.id}/wiki/${p.id}`} className="conn-chip">
                        <DocIcon size={11} /> ← {p.title}
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {/* GitHub PR · 커밋 */}
              {githubLinks.length > 0 && (
                <section className="detail-section">
                  <header className="section-head">
                    <h3>GitHub PR · 커밋 {githubLinks.length}</h3>
                  </header>
                  <div className="conn-group">
                    {githubLinks.map((g) => (
                      <a key={g.id} href={g.url} target="_blank" rel="noopener noreferrer" className="conn-chip">
                        <span className={`pill ${g.state === "merged" ? "tone-done" : g.state === "open" ? "tone-run" : "tone-stop"}`}>
                          {g.kind === "pr" ? `PR ${g.ref} ${g.state}` : g.ref}
                        </span>{" "}
                        {g.title}
                      </a>
                    ))}
                  </div>
                </section>
              )}

              {/* 첨부 파일 */}
              {(attachments.length > 0 || can("create")) && (
                <section className="detail-section">
                  <header className="section-head">
                    <h3>
                      <PaperclipIcon size={12} /> 첨부 파일 {attachments.length > 0 && attachments.length}
                    </h3>
                    <span className="spacer" />
                    {can("create") && (
                      <>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => attInput.current?.click()}>
                          + 파일 첨부
                        </button>
                        <input
                          ref={attInput}
                          type="file"
                          hidden
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            try {
                              const uploaded = await attachmentsApi.upload(project.id, f, { task_id: task.id });
                              setAttachments((prev) => [uploaded, ...prev]);
                            } catch (err) {
                              setError(err instanceof ApiError ? String(err.detail) : "첨부 업로드 실패");
                            }
                            e.target.value = "";
                          }}
                        />
                      </>
                    )}
                  </header>
                  {attachments.length > 0 && (
                    <div className="conn-group">
                      {attachments.map((att) => (
                        <span key={att.id} className="conn-chip att-chip">
                          <button
                            type="button"
                            className="link-btn"
                            onClick={async () => {
                              const { blob, filename } = await attachmentsApi.download(project.id, att.id);
                              saveBlob(blob, filename);
                            }}
                          >
                            {att.filename} ({Math.max(1, Math.round(att.size / 1024))}KB)
                          </button>
                          {can("delete") && (
                            <button
                              type="button"
                              className="chip-del"
                              title="삭제"
                              onClick={async () => {
                                if (!confirm(`'${att.filename}' 첨부를 삭제할까요?`)) return;
                                await attachmentsApi.remove(project.id, att.id);
                                setAttachments((prev) => prev.filter((x) => x.id !== att.id));
                              }}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <TaskTimeline
                links={resolver}
                comments={comments}
                activity={activity}
                users={users}
                pages={pages}
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
              cycles={cycles}
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
