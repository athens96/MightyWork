import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { attachmentsApi, commentsApi, githubApi, tasksApi, wikiApi } from "../../api";
import { ApiError, saveBlob } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { EditorSuggestBar, useEditorSuggest } from "../../components/EditorSuggest";
import { BellIcon, CloseIcon, DocIcon, EditIcon, LinkIcon, PaperclipIcon, StarIcon } from "../../components/icons";
import { RefreshButton } from "../../components/RefreshButton";
import { makeBranchName } from "../../lib/branchName";
import { clearDraft, loadDraft, saveDraft, useBeforeUnloadWarning, type SavedDraft } from "../../lib/draftStorage";
import { extractImageFile, insertUploadedImage } from "../../lib/editorUpload";
import { can as canProject } from "../../lib/permissions";
import { recordRecent, removeBookmark, togglePin, useNavBookmarks } from "../../lib/recentsAndPins";
import { PROJECT_EVENT, type ProjectEventDetail } from "../../lib/sse";
import { sortVersionLabels } from "../../lib/taskGrouping";
import { timeAgo } from "../../lib/time";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { useLinkResolver } from "../../lib/useLinkResolver";
import { Markdown } from "../../components/Markdown";
import { MarkdownToolbar } from "../../components/MarkdownToolbar";
import type { Attachment, ChecklistItem, Comment, GitHubLink, Task, TaskActivity, TaskLink, TaskLinkKind, TaskUpdate, WikiPageSummary } from "../../types";
import { useProjects } from "../projects/ProjectsContext";
import { useBoard } from "./boardContext";
import { TaskChecklist } from "./TaskChecklist";
import { TaskProperties } from "./TaskProperties";
import { TaskTimeline } from "./TaskTimeline";
import { STAGE_TONE, TASK_LINK_LABEL } from "./tones";

/** 일감 상세 — 오른쪽에서 열리는 패널 (/projects/:pid/tasks/:taskId) */
export function TaskDetailPanel() {
  const { project, tasks, stages, cycles, milestones, users, members, can, onCreated, onChanged, onDeleted } = useBoard();
  const editable = can("edit");
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const { projects: allProjects } = useProjects();
  const [task, setTask] = useState<Task | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [opsBusy, setOpsBusy] = useState(false);
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
  const [pendingDescDraft, setPendingDescDraft] = useState<SavedDraft<string> | null>(null);
  const [descCursor, setDescCursor] = useState(0);
  const [newSubTitle, setNewSubTitle] = useState("");
  const [linkKind, setLinkKind] = useState<TaskLinkKind>("relates_to");
  const [linkTarget, setLinkTarget] = useState("");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const attInput = useRef<HTMLInputElement>(null);
  const resolver = useLinkResolver(project, { tasks, pages });
  const descSuggest = useEditorSuggest(desc ?? "", descCursor, pages, members);
  const { pins } = useNavBookmarks();
  const isTaskPinned = Boolean(task && pins.some((p) => p.kind === "task" && p.id === task.id));

  useEffect(() => {
    if (!task) return;
    recordRecent({
      kind: "task",
      id: task.id,
      projectId: project.id,
      projectKey: project.key,
      label: `${project.key}-${task.number}`,
      title: task.title,
      path: `/projects/${project.id}/tasks/${task.id}`,
    });
  }, [task?.id, task?.title, task?.number, project.id, project.key]);

  const close = useCallback(() => navigate(`/projects/${project.id}/tasks`), [navigate, project.id]);
  const refreshActivity = useCallback(() => tasksApi.activity(project.id, taskId).then(setActivity), [project.id, taskId]);

  useEffect(() => {
    wikiApi.list(project.id).then(setPages, () => {});
  }, [project.id]);

  const loadDetail = useCallback(
    async (silent: boolean) => {
      if (!taskId) return;
      if (!silent) {
        setTask(null);
        setNotFound(false);
        setDesc(null);
        setError(null);
        setMoveOpen(false);
      }
      try {
        const [t, c, a, w, wl, subs, ls, atts, gh] = await Promise.all([
          tasksApi.get(project.id, taskId),
          commentsApi.list(project.id, taskId),
          tasksApi.activity(project.id, taskId),
          tasksApi.wikiRefs(project.id, taskId),
          tasksApi.wikiLinks(project.id, taskId),
          tasksApi.subtasks(project.id, taskId),
          tasksApi.links(project.id, taskId),
          attachmentsApi.list(project.id, { task_id: taskId }),
          githubApi.taskLinks(project.id, taskId).catch(() => [] as GitHubLink[]),
        ]);
        setTask(t);
        // 편집 중이 아닐 때만 제목 입력 동기화
        if (!silent || document.activeElement?.tagName !== "INPUT") setTitle(t.title);
        setComments(c);
        setActivity(a);
        setWikiRefs(w);
        setWikiLinks(wl);
        setSubtasks(subs);
        setTaskLinks(ls);
        setAttachments(atts);
        setGithubLinks(gh);
        onChanged(t);
      } catch {
        if (!silent) setNotFound(true);
      }
    },
    [project.id, taskId, onChanged],
  );

  useEffect(() => {
    void loadDetail(false);
  }, [project.id, taskId]);

  const { refreshing: detailRefreshing, lastUpdated: detailUpdated, refresh: refreshDetail } = useAutoRefresh(
    () => loadDetail(true),
    { intervalMs: 30_000, enabled: Boolean(taskId) },
  );

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
    if (
      body.stage === "in_progress" &&
      task.stage !== "in_progress" &&
      unresolvedBlockers.length > 0 &&
      !confirm(`미완료 선행 일감 ${unresolvedBlockers.length}건에 차단되어 있습니다. 그래도 '진행 중'으로 이동할까요?`)
    ) {
      return;
    }
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

  const duplicateTask = async () => {
    if (!task || opsBusy) return;
    setOpsBusy(true);
    setError(null);
    try {
      const copy = await tasksApi.duplicate(project.id, task.id);
      onCreated(copy);
      navigate(`/projects/${project.id}/tasks/${copy.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? String(e.detail) : "일감 복제에 실패했습니다.");
    } finally {
      setOpsBusy(false);
    }
  };

  const moveToProject = async (targetId: string, targetName: string) => {
    if (!task || opsBusy) return;
    setMoveOpen(false);
    if (!confirm(`"${task.title}" 일감을 '${targetName}' 프로젝트로 이동할까요?\n상위·하위 연결, 사이클·마일스톤, 일감 간 링크는 초기화됩니다.`)) return;
    setOpsBusy(true);
    setError(null);
    try {
      const moved = await tasksApi.move(project.id, task.id, targetId);
      removeBookmark("task", task.id);
      onDeleted(task.id);
      navigate(`/projects/${targetId}/tasks/${moved.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? String(e.detail) : "프로젝트 이동에 실패했습니다.");
    } finally {
      setOpsBusy(false);
    }
  };

  const completeParent = async () => {
    if (!parentTask || opsBusy) return;
    setOpsBusy(true);
    try {
      const updatedParent = await tasksApi.update(project.id, parentTask.id, { stage: "done" });
      onChanged(updatedParent);
    } catch (e) {
      setError(e instanceof ApiError ? String(e.detail) : "상위 일감 완료 처리에 실패했습니다.");
    } finally {
      setOpsBusy(false);
    }
  };

  const syncCount = (next: Comment[]) => {
    setComments(next);
    if (task) onChanged({ ...task, comment_count: next.length });
  };

  const remove = async () => {
    if (!task || !confirm(`"${task.title}" 일감을 삭제할까요?\n덧글과 이력도 함께 삭제됩니다.`)) return;
    await tasksApi.remove(project.id, task.id);
    removeBookmark("task", task.id);
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

  const promoteChecklistItem = async (item: ChecklistItem, index: number) => {
    if (!task || opsBusy) return;
    setOpsBusy(true);
    setError(null);
    try {
      const created = await tasksApi.create(project.id, {
        title: item.text.slice(0, 200),
        parent_id: task.id,
        stage: item.done ? "done" : "todo",
      });
      setSubtasks((prev) => [...prev, created]);
      onCreated(created);
      const nextChecklist = task.checklist.filter((_, i) => i !== index);
      const updated = await tasksApi.update(project.id, task.id, { checklist: nextChecklist });
      setTask(updated);
      onChanged(updated);
      refreshActivity();
    } catch (e) {
      setError(e instanceof ApiError ? String(e.detail) : "하위 일감 승격에 실패했습니다.");
    } finally {
      setOpsBusy(false);
    }
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

  const descDraftKey = task ? `task-desc:${project.id}:${task.id}` : null;
  const isDescDirty = Boolean(task && desc !== null && desc !== task.description);
  useBeforeUnloadWarning(isDescDirty);

  useEffect(() => {
    if (!task || !descDraftKey || desc === null) return;
    if (desc === task.description) {
      clearDraft(descDraftKey);
      return;
    }
    const id = window.setTimeout(() => saveDraft(descDraftKey, desc, task.updated_at), 500);
    return () => window.clearTimeout(id);
  }, [task, descDraftKey, desc]);

  useEffect(() => {
    if (!task || !descDraftKey || !editable) {
      setPendingDescDraft(null);
      return;
    }
    const saved = loadDraft<string>(descDraftKey);
    if (saved && saved.data !== task.description) {
      setPendingDescDraft(saved);
    } else {
      setPendingDescDraft(null);
    }
  }, [task?.id, task?.description, descDraftKey, editable]);

  const saveDesc = async () => {
    if (desc === null) return;
    await patch({ description: desc });
    if (descDraftKey) clearDraft(descDraftKey);
    setPendingDescDraft(null);
    setDesc(null);
  };

  const cancelDesc = () => {
    if (isDescDirty && !confirm("저장하지 않은 설명 변경사항을 버릴까요?")) return;
    if (descDraftKey) clearDraft(descDraftKey);
    setPendingDescDraft(null);
    setDesc(null);
  };

  const toggleWatch = async () => {
    if (!task || opsBusy) return;
    setOpsBusy(true);
    try {
      const updated = await tasksApi.toggleWatch(project.id, task.id);
      setTask(updated);
      onChanged(updated);
    } finally {
      setOpsBusy(false);
    }
  };

  const isWatching = Boolean(task && me && (task.watcher_ids ?? []).includes(me.id));
  const watcherCount = task?.watcher_ids?.length ?? 0;

  const taskKey = task ? `${project.key}-${task.number}` : "";
  const parentTask = task?.parent_id ? tasks.find((t) => t.id === task.parent_id) : undefined;
  const linkCandidates = tasks.filter((t) => t.id !== task?.id);
  const moveTargets = allProjects.filter((p) => p.id !== project.id && canProject(p, "create"));
  const unresolvedBlockers = taskLinks.filter((l) => l.kind === "blocked_by" && l.stage !== "done");
  const allSubtasksDone = Boolean(task && task.stage !== "done" && subtasks.length > 0 && subtasks.every((s) => s.stage === "done"));
  const siblingSubtasks = parentTask ? tasks.filter((t) => t.parent_id === parentTask.id) : [];
  const allSiblingsDone = Boolean(
    task &&
      task.stage === "done" &&
      parentTask &&
      parentTask.stage !== "done" &&
      siblingSubtasks.length > 0 &&
      siblingSubtasks.every((s) => s.stage === "done"),
  );

  return (
    <>
      <div className="sheet-backdrop" onClick={close} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={taskKey || "일감"}>
        <header className="sheet-head">
          <span className="key-badge">{taskKey || "…"}</span>
          {task?.via_client && (
            <span className="pill tone-agent agent-via" title={`MCP 클라이언트(${task.via_client})를 통해 생성됨`}>
              via {task.via_client}
            </span>
          )}
          <span className="sheet-title">{task?.title}</span>
          <RefreshButton compact refreshing={detailRefreshing} lastUpdated={detailUpdated} onClick={refreshDetail} />
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
          {task && can("create") && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={opsBusy} onClick={duplicateTask} title="현재 일감 복제">
              복제
            </button>
          )}
          {task && can("delete") && moveTargets.length > 0 && (
            <div className="menu-anchor">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={opsBusy}
                onClick={() => setMoveOpen((o) => !o)}
                title="다른 프로젝트로 이동"
              >
                이동
              </button>
              {moveOpen && (
                <div className="popover move-project-menu">
                  <div className="move-project-head">이동할 프로젝트 선택</div>
                  {moveTargets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="menu-item"
                      onClick={() => moveToProject(p.id, p.name)}
                    >
                      <span>{p.name}</span>
                      <span className="mono muted">{p.key}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {task && (
            <button
              type="button"
              className={`btn btn-sm ${isWatching ? "btn-accent" : "btn-ghost"}`}
              aria-pressed={isWatching}
              disabled={opsBusy}
              onClick={toggleWatch}
              title={isWatching ? "일감 알림 구독 해제" : "이 일감의 변경·덧글 알림 구독"}
            >
              <BellIcon size={12} /> {isWatching ? "구독 중" : "구독"}
              {watcherCount > 0 && <span className="mono">{watcherCount}</span>}
            </button>
          )}
          {task && (
            <button
              type="button"
              className={`icon-btn star-btn ${isTaskPinned ? "is-pinned" : ""}`}
              title={isTaskPinned ? "즐겨찾기 해제" : "즐겨찾기에 고정"}
              aria-pressed={isTaskPinned}
              onClick={() =>
                togglePin({
                  kind: "task",
                  id: task.id,
                  projectId: project.id,
                  projectKey: project.key,
                  label: taskKey,
                  title: task.title,
                  path: `/projects/${project.id}/tasks/${task.id}`,
                })
              }
            >
              <StarIcon size={13} filled={isTaskPinned} />
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
              {unresolvedBlockers.length > 0 && task.stage !== "done" && (
                <div className="alert tone-err task-banner" role="alert">
                  <div className="task-banner-text">
                    <strong>차단됨</strong> — 미완료 선행 일감 {unresolvedBlockers.length}건이 먼저 끝나야 합니다:{" "}
                    {unresolvedBlockers.map((b, idx) => (
                      <span key={b.id}>
                        {idx > 0 && ", "}
                        <Link to={`/projects/${project.id}/tasks/${b.task_id}`} className="mono">
                          {project.key}-{b.number} {b.title}
                        </Link>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {parentTask && (
                <div className="parent-crumb">
                  <span className="muted">상위 일감</span>
                  <Link to={`/projects/${project.id}/tasks/${parentTask.id}`} className="conn-chip">
                    {project.key}-{parentTask.number} {parentTask.title}
                  </Link>
                </div>
              )}
              {allSiblingsDone && parentTask && editable && (
                <div className="task-banner task-banner-done">
                  <span className="task-banner-text">
                    상위 일감 <strong>{project.key}-{parentTask.number}</strong> 의 하위 일감({siblingSubtasks.length}/{siblingSubtasks.length})이 모두 완료되었습니다.
                  </span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={opsBusy} onClick={completeParent}>
                    상위 일감 완료 처리
                  </button>
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
                {pendingDescDraft && desc === null && editable && (
                  <div className="task-banner draft-banner" role="status">
                    <span className="task-banner-text">
                      저장하지 않은 설명 초안이 있습니다 ({timeAgo(new Date(pendingDescDraft.savedAt).toISOString())}).
                    </span>
                    <div className="wiki-conflict-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setDesc(pendingDescDraft.data);
                          setPendingDescDraft(null);
                        }}
                      >
                        초안 복원
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          if (descDraftKey) clearDraft(descDraftKey);
                          setPendingDescDraft(null);
                        }}
                      >
                        버리기
                      </button>
                    </div>
                  </div>
                )}
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
                    <MarkdownToolbar textareaRef={descRef} value={desc} onChange={setDesc} />
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
                      <button className="btn btn-ghost" onClick={cancelDesc}>
                        취소
                      </button>
                      <button className="btn btn-primary" onClick={saveDesc}>
                        저장
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <TaskChecklist
                items={task.checklist}
                readOnly={!editable}
                onChange={(checklist) => patch({ checklist })}
                onPromote={can("create") && editable ? promoteChecklistItem : undefined}
              />

              {/* 하위 일감 */}
              <section className="detail-section">
                <header className="section-head">
                  <h3>하위 일감 {subtasks.length > 0 && `${subtasks.filter((s) => s.stage === "done").length}/${subtasks.length}`}</h3>
                </header>
                {allSubtasksDone && editable && (
                  <div className="task-banner task-banner-done">
                    <span className="task-banner-text">
                      모든 하위 일감({subtasks.length}/{subtasks.length})이 완료되었습니다. 이 상위 일감도 완료 처리할까요?
                    </span>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => patch({ stage: "done" })}>
                      완료 처리
                    </button>
                  </div>
                )}
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
                onToggleReaction={async (id, emoji) => {
                  const updated = await commentsApi.toggleReaction(project.id, task.id, id, emoji);
                  setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
                }}
              />
            </div>

            <TaskProperties
              key={task.id}
              task={task}
              stages={stages}
              cycles={cycles}
              milestones={milestones}
              versions={sortVersionLabels([...new Set(tasks.flatMap((t) => (t.version ? [t.version] : [])))])}
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
