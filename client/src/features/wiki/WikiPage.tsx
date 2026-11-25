import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { attachmentsApi, membersApi, tasksApi, wikiApi } from "../../api";
import { ApiError, saveBlob } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import type { Attachment, LocalGraph, PageLinks, UnlinkedMention, User, WikiComment, WikiPage as WikiPageType, WikiPageSummary } from "../../types";
import { LocalGraphView } from "./LocalGraphView";
import { ExportMenu } from "./ExportMenu";
import { PropertiesBar, PropertiesEditor } from "./pageProps";
import { WikiComments } from "./WikiComments";
import { WikiHistoryDrawer } from "./WikiHistoryDrawer";
import { WikiIndex } from "./WikiIndex";
import { useCurrentProject } from "../projects/ProjectLayout";
import { EditorSuggestBar, useEditorSuggest } from "../../components/EditorSuggest";
import { ChevronIcon, EditIcon, HistoryIcon, PaperclipIcon, PlusIcon, StarIcon, TrashIcon } from "../../components/icons";
import { Markdown, TableOfContents } from "../../components/Markdown";
import { MarkdownToolbar } from "../../components/MarkdownToolbar";
import { RefreshButton } from "../../components/RefreshButton";
import { extractHeadings } from "../../lib/markdownHelpers";
import { clearDraft, loadDraft, saveDraft, useBeforeUnloadWarning, type SavedDraft } from "../../lib/draftStorage";
import { can } from "../../lib/permissions";
import { recordRecent, removeBookmark, togglePin, useNavBookmarks } from "../../lib/recentsAndPins";
import type { ProjectEventDetail } from "../../lib/sse";
import { useProjectSSE } from "../../lib/useProjectSSE";
import { extractImageFile, insertUploadedImage } from "../../lib/editorUpload";
import { timeAgo, todayYmd } from "../../lib/time";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { useLinkResolver } from "../../lib/useLinkResolver";
import { decidePageSyncAction, planWikiRefresh } from "../../lib/wikiRefresh";
import { collectDescendantIds, WIKI_TEMPLATES, type WikiTemplate } from "../../lib/wikiTemplates";
import { injectTaskKeyIntoChecklist, injectTaskKeyIntoSelection } from "../../lib/wikiToTask";
import { STAGE_TONE } from "../tasks/tones";
import { WikiTree } from "./WikiTree";

export function WikiPage() {
  const project = useCurrentProject();
  const { user: me } = useAuth();
  const basePath = `/projects/${project.id}/wiki`;
  const canCreate = can(project, "create");
  const canEdit = can(project, "edit");
  const canDelete = can(project, "delete");
  const canAdmin = can(project, "admin");
  const { pageId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [page, setPage] = useState<WikiPageType | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [pendingDraft, setPendingDraft] = useState<SavedDraft<Draft> | null>(null);
  const [conflict, setConflict] = useState<WikiPageType | null>(null);
  const [comments, setComments] = useState<WikiComment[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [mentions, setMentions] = useState<UnlinkedMention[]>([]);
  const [graph, setGraph] = useState<LocalGraph | null>(null);
  const [graphDepth, setGraphDepth] = useState<1 | 2>(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const attInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [editorCursor, setEditorCursor] = useState(0);
  const [importing, setImporting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selectionPop, setSelectionPop] = useState<{ text: string; top: number; left: number } | null>(null);
  const [createdNotice, setCreatedNotice] = useState<{ id: string; key: string; title: string } | null>(null);
  const mdWrapRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const pageRef = useRef(page);
  pageRef.current = page;
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  const suggest = useEditorSuggest(draft.content, editorCursor, pages, members);
  const { pins } = useNavBookmarks();
  const isPagePinned = Boolean(page && pins.some((p) => p.kind === "wiki" && p.id === page.id));

  useEffect(() => {
    if (!page) return;
    recordRecent({
      kind: "wiki",
      id: page.id,
      projectId: project.id,
      projectKey: project.key,
      label: project.key,
      title: page.title,
      path: `${basePath}/${page.id}`,
    });
  }, [page?.id, page?.title, project.id, project.key, basePath]);

  // HWP·HWPX·DOCX·PDF·Markdown 파일 → 새 위키 페이지
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const created = await wikiApi.import(project.id, file);
      await reloadTree();
      navigate(`${basePath}/${created.id}`);
    } catch (e) {
      alert(e instanceof ApiError ? `가져오기 실패: ${String(e.detail)}` : "가져오기에 실패했습니다.");
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const [links, setLinks] = useState<PageLinks | null>(null);

  const reloadTree = useCallback(() => wikiApi.list(project.id).then(setPages), [project.id]);

  useEffect(() => {
    reloadTree();
    membersApi.list(project.id).then((m) => setMembers(m.flatMap((x) => (x.user ? [x.user] : []))), () => {});
  }, [reloadTree, project.id]);

  // 새 페이지 생성 직후에는 navigate state 로 편집 모드 진입
  const openInEditMode = (location.state as { edit?: boolean } | null)?.edit === true;

  useEffect(() => {
    setEditing(false);
    setConflict(null);
    setNavOpen(false);
    setSelectionPop(null);
    setCreatedNotice(null);
    if (!pageId) return setPage(null);
    let cancelled = false;
    wikiApi.get(project.id, pageId).then(
      (p) => {
        if (cancelled) return;
        setPage(p);
        if (openInEditMode) {
          setDraft(toDraft(p));
          setEditing(true);
        }
      },
      () => !cancelled && setPage(null),
    );
    return () => {
      cancelled = true;
    };
    // 페이지 전환(pageId 변경) 시에만 실행
  }, [pageId]);

  const createPage = async (parentId: string | null, title = "제목 없음") => {
    const created = await wikiApi.create(project.id, { title, parent_id: parentId });
    await reloadTree();
    navigate(`${basePath}/${created.id}`, { state: { edit: true } });
  };

  const createFromTemplate = async (tpl: WikiTemplate, parentId: string | null = null) => {
    setTplOpen(false);
    const today = todayYmd();
    const created = await wikiApi.create(project.id, {
      title: tpl.makeTitle(today),
      content: tpl.makeContent(today),
      parent_id: parentId,
      page_type: tpl.page_type,
      status: tpl.status,
      tags: [...tpl.tags],
    });
    await reloadTree();
    navigate(`${basePath}/${created.id}`, { state: { edit: true } });
  };

  const movePage = async (targetId: string, newParentId: string | null) => {
    try {
      const updated = await wikiApi.update(project.id, targetId, { parent_id: newParentId });
      await reloadTree();
      if (page?.id === targetId) setPage(updated);
    } catch (e) {
      alert(e instanceof ApiError ? String(e.detail) : "페이지 이동에 실패했습니다.");
    }
  };

  // [[없는 페이지]] 클릭 → 그 제목으로 새 페이지 (생성 권한 있을 때만)
  const onMissing = useCallback(
    (title: string) => {
      if (confirm(`'${title}' 페이지가 아직 없습니다. 새로 만들까요?`)) createPage(null, title);
    },
    [project.id], // createPage 는 project 에만 의존
  );
  const resolver = useLinkResolver(project, { pages, onMissing: canCreate ? onMissing : undefined });

  const reloadLinks = useCallback(
    (id: string) =>
      Promise.all([
        wikiApi.links(project.id, id).then(setLinks, () => setLinks(null)),
        wikiApi.unlinkedMentions(project.id, id).then(setMentions, () => setMentions([])),
        wikiApi.graph(project.id, id, graphDepth).then(setGraph, () => setGraph(null)),
        attachmentsApi.list(project.id, { wiki_page_id: id }).then(setAttachments, () => setAttachments([])),
        wikiApi.listComments(project.id, id).then(setComments, () => setComments([])),
      ]),
    [project.id, graphDepth],
  );
  useEffect(() => {
    setLinks(null);
    setMentions([]);
    setGraph(null);
    setComments([]);
    if (pageId) reloadLinks(pageId);
  }, [pageId, reloadLinks]);

  // 활성 페이지 단건 재조회 (편집 중이면 초안을 덮어쓰지 않고 충돌 배너만 띄움)
  const reloadActivePage = useCallback(
    async (id: string) => {
      try {
        const latest = await wikiApi.get(project.id, id);
        if (pageIdRef.current !== id) return;
        const action = decidePageSyncAction(editingRef.current, pageRef.current?.updated_at, latest.updated_at);
        if (action === "replace") {
          setPage(latest);
        } else if (action === "conflict") {
          setConflict(latest);
        }
      } catch (e) {
        if (pageIdRef.current !== id) return;
        if (e instanceof ApiError && e.status === 404 && !editingRef.current) {
          setPage(null);
          navigate(basePath, { replace: true });
        }
      }
    },
    [project.id, basePath, navigate],
  );

  const reloadAll = useCallback(async () => {
    const tasks: Promise<unknown>[] = [reloadTree()];
    const activeId = pageIdRef.current;
    if (activeId) {
      tasks.push(reloadActivePage(activeId));
      tasks.push(reloadLinks(activeId));
    }
    await Promise.all(tasks);
  }, [reloadTree, reloadActivePage, reloadLinks]);

  const { refreshing, lastUpdated, refresh, markUpdated } = useAutoRefresh(reloadAll, {
    intervalMs: 30_000,
    shortcutKey: true,
  });

  const sseHandlersRef = useRef({ reloadTree, reloadActivePage, reloadLinks, reloadAll, markUpdated });
  sseHandlersRef.current = { reloadTree, reloadActivePage, reloadLinks, reloadAll, markUpdated };

  // MW-39 & MW-40: Layout 의 단일 프로젝트 SSE 스트림을 공유 구독 + 재연결 시 전체 동기화
  const sseTimersRef = useRef<{
    wiki?: number;
    link?: number;
    pendingTree: boolean;
    pendingPage: boolean;
    pendingLinks: boolean;
  }>({ pendingTree: false, pendingPage: false, pendingLinks: false });

  useEffect(() => {
    const t = sseTimersRef.current;
    return () => {
      if (t.wiki) window.clearTimeout(t.wiki);
      if (t.link) window.clearTimeout(t.link);
      t.wiki = undefined;
      t.link = undefined;
      t.pendingTree = false;
      t.pendingPage = false;
      t.pendingLinks = false;
    };
  }, [project.id]);

  const handleWikiProjectEvent = useCallback(
    (msg: ProjectEventDetail) => {
      const h = sseHandlersRef.current;
      const t = sseTimersRef.current;
      const activeId = pageIdRef.current;
      const plan = planWikiRefresh(msg.event, msg.data, activeId);

      if (plan.comments && activeId) {
        wikiApi.listComments(project.id, activeId).then((list) => {
          if (pageIdRef.current === activeId) {
            setComments(list);
            h.markUpdated();
          }
        }, () => {});
        return;
      }

      if (plan.tree || plan.page) {
        t.pendingTree = t.pendingTree || plan.tree;
        t.pendingPage = t.pendingPage || plan.page;
        t.pendingLinks = t.pendingLinks || plan.links;
        if (t.wiki) window.clearTimeout(t.wiki);
        t.wiki = window.setTimeout(() => {
          const needTree = t.pendingTree;
          const needPage = t.pendingPage;
          const needLinks = t.pendingLinks;
          t.pendingTree = false;
          t.pendingPage = false;
          t.pendingLinks = false;
          t.wiki = undefined;
          const latestH = sseHandlersRef.current;
          const jobs: Promise<unknown>[] = [];
          if (needTree) jobs.push(latestH.reloadTree());
          const curId = pageIdRef.current;
          if (curId && needPage) jobs.push(latestH.reloadActivePage(curId));
          if (curId && needLinks) jobs.push(latestH.reloadLinks(curId));
          if (jobs.length > 0) void Promise.all(jobs).then(latestH.markUpdated, () => {});
        }, 150);
        return;
      }

      if (plan.links && activeId) {
        if (t.link) window.clearTimeout(t.link);
        t.link = window.setTimeout(() => {
          t.link = undefined;
          const curId = pageIdRef.current;
          const latestH = sseHandlersRef.current;
          if (curId) void latestH.reloadLinks(curId).then(latestH.markUpdated, () => {});
        }, 250);
      }
    },
    [project.id],
  );

  const handleWikiProjectReconnect = useCallback(() => {
    const h = sseHandlersRef.current;
    void h.reloadAll().then(h.markUpdated, () => {});
  }, []);

  const liveStatus = useProjectSSE(project.id, handleWikiProjectEvent, handleWikiProjectReconnect);

  // 링크 안 된 언급 → [[링크]] 로 바꾸기 (편집 권한)
  const linkMentions = async (sources: UnlinkedMention[]) => {
    if (!page || sources.length === 0) return;
    await wikiApi.linkMentions(project.id, page.id, sources);
    await reloadLinks(page.id);
  };

  const addAlias = () => {
    const v = aliasDraft.trim();
    if (v && !draft.aliases.some((a) => a.toLowerCase() === v.toLowerCase())) setDraft({ ...draft, aliases: [...draft.aliases, v] });
    setAliasDraft("");
  };

  /** 상위 페이지 경로(루트 → 부모 순) */
  const ancestors = (parentId: string | null): WikiPageSummary[] => {
    const chain: WikiPageSummary[] = [];
    for (let id = parentId; id; ) {
      const parent = pages.find((p) => p.id === id);
      if (!parent || chain.includes(parent)) break;
      chain.unshift(parent);
      id = parent.parent_id;
    }
    return chain;
  };

  const draftKey = page ? `wiki:${project.id}:${page.id}` : null;
  const isDraftDirty = Boolean(
    editing &&
      page &&
      (draft.title !== page.title ||
        draft.content !== page.content ||
        draft.parent_id !== page.parent_id ||
        draft.page_type !== page.page_type ||
        draft.status !== page.status ||
        draft.owner_id !== page.owner_id ||
        JSON.stringify(draft.aliases) !== JSON.stringify(page.aliases) ||
        JSON.stringify(draft.tags) !== JSON.stringify(page.tags)),
  );
  useBeforeUnloadWarning(isDraftDirty);

  // 편집 중 자동 임시저장 (500ms 디바운스)
  useEffect(() => {
    if (!editing || !page || !draftKey) return;
    if (!isDraftDirty) {
      clearDraft(draftKey);
      return;
    }
    const id = window.setTimeout(() => saveDraft(draftKey, draft, page.updated_at), 500);
    return () => window.clearTimeout(id);
  }, [editing, page, draftKey, draft, isDraftDirty]);

  // 페이지 로드 시 저장되지 않은 로컬 초안 확인
  useEffect(() => {
    if (!page || !draftKey || !canEdit) {
      setPendingDraft(null);
      return;
    }
    const saved = loadDraft<Draft>(draftKey);
    if (saved && (saved.data.title !== page.title || saved.data.content !== page.content)) {
      setPendingDraft(saved);
    } else {
      setPendingDraft(null);
    }
  }, [page?.id, page?.updated_at, draftKey, canEdit]);

  useEffect(() => {
    document.body.classList.toggle("mw-focus-mode", focusMode);
    return () => document.body.classList.remove("mw-focus-mode");
  }, [focusMode]);

  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']");
      if (!typing && e.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);

  const startEdit = () => {
    if (!page) return;
    setDraft(toDraft(page));
    setConflict(null);
    setEditing(true);
  };

  const restorePendingDraft = () => {
    if (!page || !pendingDraft) return;
    setDraft({ ...toDraft(page), ...pendingDraft.data });
    setPendingDraft(null);
    setConflict(null);
    setEditing(true);
  };

  const discardPendingDraft = () => {
    if (draftKey) clearDraft(draftKey);
    setPendingDraft(null);
  };

  const cancelEdit = () => {
    if (isDraftDirty && !confirm("저장하지 않은 변경사항을 버릴까요?")) return;
    if (draftKey) clearDraft(draftKey);
    setPendingDraft(null);
    setConflict(null);
    setEditing(false);
  };

  const save = async (force = false) => {
    if (!page) return;
    setConflict(null);
    try {
      const payload = force ? draft : { ...draft, expected_updated_at: page.updated_at };
      const updated = await wikiApi.update(project.id, page.id, payload);
      if (draftKey) clearDraft(draftKey);
      setPendingDraft(null);
      setPage(updated);
      setEditing(false);
      reloadTree();
      reloadLinks(updated.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const latest = await wikiApi.get(project.id, page.id).catch(() => null);
        setConflict(latest ?? page);
        return;
      }
      alert(e instanceof ApiError ? String(e.detail) : "저장에 실패했습니다.");
    }
  };

  // MW-8: 위키 체크리스트 항목 또는 드래그 선택한 텍스트로 원클릭 일감 생성 + MW-n 키 자동 삽입
  const createTaskFromWiki = useCallback(
    async (rawText: string, mode: "checklist" | "selection") => {
      if (!page || !canCreate || !canEdit) return;
      const clean = rawText.replace(/\s+/g, " ").trim();
      if (!clean) return;
      const title = clean.slice(0, 180);
      const created = await tasksApi.create(project.id, {
        title,
        description: `출처 위키: [[${page.title}]]\n\n> ${clean}`,
      });
      const key = `${project.key}-${created.number}`;
      const nextContent =
        mode === "checklist"
          ? injectTaskKeyIntoChecklist(page.content, rawText, key)
          : injectTaskKeyIntoSelection(page.content, rawText, key);
      if (nextContent !== page.content) {
        const updated = await wikiApi.update(project.id, page.id, { content: nextContent });
        setPage(updated);
      }
      setSelectionPop(null);
      window.getSelection()?.removeAllRanges();
      setCreatedNotice({ id: created.id, key, title: created.title });
      reloadLinks(page.id);
    },
    [page, project.id, project.key, canCreate, canEdit, reloadLinks],
  );

  const handleWikiMouseUp = () => {
    if (!canCreate || !canEdit || !mdWrapRef.current) {
      setSelectionPop(null);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelectionPop(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 300) {
      setSelectionPop(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!mdWrapRef.current.contains(range.commonAncestorContainer)) {
      setSelectionPop(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    setSelectionPop({
      text,
      top: Math.max(8, rect.top - 38),
      left: Math.min(window.innerWidth - 180, Math.max(12, rect.left + rect.width / 2 - 75)),
    });
  };

  const remove = async () => {
    if (!page || !confirm(`"${page.title}" 페이지를 휴지통으로 옮길까요?\n30일 이내에 휴지통에서 복구할 수 있습니다.`)) return;
    try {
      await wikiApi.remove(project.id, page.id);
      removeBookmark("wiki", page.id);
      await reloadTree();
      navigate(basePath);
    } catch (e) {
      alert(e instanceof ApiError && e.status === 409 ? "하위 페이지를 먼저 삭제하거나 옮겨주세요." : "삭제 실패");
    }
  };

  return (
    <div className={`wiki ${focusMode ? "is-focus" : ""}`}>
      <aside className={`pane wiki-nav ${pageId && !navOpen ? "is-collapsed-mobile" : ""}`}>
        <div className="pane-header">
          <span className="pane-title">페이지 {pages.length}</span>
          <RefreshButton compact refreshing={refreshing} lastUpdated={lastUpdated} onClick={refresh} shortcut />
          {pageId && (
            <button type="button" className="btn btn-sm btn-ghost wiki-nav-toggle" onClick={() => setNavOpen((o) => !o)}>
              {navOpen ? "접기" : "목차"}
            </button>
          )}
          <Link to={basePath} className="btn btn-sm btn-ghost" title="문서 목록 (속성으로 거르기)">
            목록
          </Link>
          {canCreate && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => fileInput.current?.click()} disabled={importing} title="HWP·HWPX·DOCX·PDF·Markdown 가져오기">
                {importing ? "가져오는 중…" : "가져오기"}
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept=".hwp,.hwpx,.docx,.pdf,.pptx,.xlsx,.md,.markdown,.txt"
                onChange={(e) => importFile(e.target.files?.[0])}
              />
              <div className="menu-anchor">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setTplOpen((o) => !o)}
                  title="문서 템플릿으로 새 페이지 만들기"
                >
                  템플릿
                </button>
                {tplOpen && (
                  <div className="popover wiki-tpl-menu">
                    {WIKI_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        className="menu-item"
                        onClick={() => createFromTemplate(tpl, page?.id ?? null)}
                      >
                        <span>{tpl.label}</span>
                        <span className="muted">{tpl.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="icon-btn" onClick={() => createPage(null)} title="새 페이지">
                <PlusIcon size={12} />
              </button>
            </>
          )}
        </div>
        <div className="tree-wrap">
          {pages.length === 0 ? (
            <p className="wiki-empty-nav">아직 페이지가 없습니다.{canCreate && " + 를 눌러 첫 페이지를 만드세요."}</p>
          ) : (
            <WikiTree
              projectId={project.id}
              pages={pages}
              basePath={basePath}
              canEdit={canEdit}
              onMovePage={canEdit ? movePage : undefined}
            />
          )}
        </div>
      </aside>

      <article className="pane wiki-body">
        {!pageId && (
          <WikiIndex
            pages={pages}
            users={members}
            basePath={basePath}
            projectId={project.id}
            refreshing={refreshing}
            lastUpdated={lastUpdated}
            onRefresh={refresh}
            liveStatus={liveStatus}
          />
        )}
        {pageId && !page && <div className="empty">불러오는 중…</div>}

        {page && !editing && (
          <>
            <div className="pane-header">
              <nav className="pane-title crumbs" aria-label="경로">
                {ancestors(page.parent_id).map((a) => (
                  <span key={a.id} className="crumbs">
                    <Link to={`${basePath}/${a.id}`}>{a.title}</Link>
                    <ChevronIcon size={9} />
                  </span>
                ))}
                <span className="current">{page.title}</span>
              </nav>
              <RefreshButton compact refreshing={refreshing} lastUpdated={lastUpdated} onClick={refresh} shortcut />
              <span
                className={`live-pill ${liveStatus === "connected" ? "is-live" : ""}`}
                title={liveStatus === "connected" ? "실시간 동기화 연결됨 (SSE) · 30초마다 자동 보강" : "실시간 연결 재시도 중 · 30초마다 자동 새로고침"}
              >
                <span className="live-dot" />
                {liveStatus === "connected" ? "실시간" : "연결 중"}
              </span>
              <button
                type="button"
                className={`icon-btn star-btn ${isPagePinned ? "is-pinned" : ""}`}
                title={isPagePinned ? "즐겨찾기 해제" : "즐겨찾기에 고정"}
                aria-pressed={isPagePinned}
                onClick={() =>
                  togglePin({
                    kind: "wiki",
                    id: page.id,
                    projectId: project.id,
                    projectKey: project.key,
                    label: project.key,
                    title: page.title,
                    path: `${basePath}/${page.id}`,
                  })
                }
              >
                <StarIcon size={13} filled={isPagePinned} />
              </button>
              <button
                type="button"
                className={`btn btn-sm ${focusMode ? "btn-accent" : "btn-ghost"}`}
                aria-pressed={focusMode}
                onClick={() => setFocusMode((f) => !f)}
                title={focusMode ? "집중 보기 해제 (Esc)" : "사이드바와 트리를 접고 문서에 집중"}
              >
                {focusMode ? "집중 해제" : "집중 보기"}
              </button>
              <ExportMenu projectId={project.id} pageId={page.id} hasChildren={pages.some((p) => p.parent_id === page.id)} />
              <button className="btn btn-sm" onClick={() => setHistoryOpen(true)} title="버전 히스토리">
                <HistoryIcon size={12} /> 히스토리
              </button>
              {canCreate && (
                <button className="btn btn-sm" onClick={() => createPage(page.id)}>
                  <PlusIcon size={10} /> 하위 페이지
                </button>
              )}
              {canEdit && (
                <button className="btn btn-sm btn-primary" onClick={startEdit}>
                  <EditIcon size={12} /> 편집
                </button>
              )}
              {canDelete && (
                <button className="icon-btn danger" onClick={remove} title="삭제">
                  <TrashIcon size={13} />
                </button>
              )}
            </div>
            <div className="wiki-doc">
              <h1 className="wiki-doc-title">{page.title}</h1>
              <p className="wiki-doc-meta">
                {timeAgo(page.updated_at)} 수정
                {page.aliases.length > 0 && (
                  <span className="alias-list">
                    별칭
                    {page.aliases.map((a) => (
                      <span key={a} className="tag">
                        {a}
                      </span>
                    ))}
                  </span>
                )}
              </p>
              <PropertiesBar page={page} users={members} basePath={basePath} />
              {pendingDraft && canEdit && (
                <div className="task-banner draft-banner" role="status">
                  <span className="task-banner-text">
                    저장하지 않은 임시 초안이 있습니다 ({timeAgo(new Date(pendingDraft.savedAt).toISOString())}).
                  </span>
                  <div className="wiki-conflict-actions">
                    <button type="button" className="btn btn-sm btn-primary" onClick={restorePendingDraft}>
                      임시 초안 복원
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={discardPendingDraft}>
                      버리기
                    </button>
                  </div>
                </div>
              )}
              {createdNotice && (
                <div className="wiki-toast">
                  <span>
                    <strong className="mono">{createdNotice.key}</strong> 일감을 만들고 문서에 링크를 삽입했습니다.
                  </span>
                  <Link to={`/projects/${project.id}/tasks/${createdNotice.id}`} className="btn btn-sm btn-primary">
                    일감 열기 →
                  </Link>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCreatedNotice(null)}>
                    닫기
                  </button>
                </div>
              )}
              {page.content ? (
                <>
                  <TableOfContents headings={extractHeadings(page.content)} />
                  <div ref={mdWrapRef} onMouseUp={handleWikiMouseUp}>
                    <Markdown
                      links={resolver}
                      projectKey={project.key}
                      onConvertChecklistItem={canCreate && canEdit ? (txt) => createTaskFromWiki(txt, "checklist") : undefined}
                    >
                      {page.content}
                    </Markdown>
                  </div>
                </>
              ) : (
                <p className="muted">내용 없음{canEdit && " — 편집을 눌러 작성하세요."}</p>
              )}
              {selectionPop && (
                <button
                  type="button"
                  className="wiki-selection-pop"
                  style={{ top: selectionPop.top, left: selectionPop.left }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => createTaskFromWiki(selectionPop.text, "selection")}
                >
                  + 선택 텍스트로 일감 생성
                </button>
              )}
              {(attachments.length > 0 || canCreate) && (
                <section className="wiki-attachments">
                  <header className="section-head">
                    <h3>
                      <PaperclipIcon size={12} /> 첨부 파일 {attachments.length}
                    </h3>
                    <span className="spacer" />
                    {canCreate && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => attInput.current?.click()}>
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
                              const uploaded = await attachmentsApi.upload(project.id, f, { wiki_page_id: page.id });
                              setAttachments((prev) => [uploaded, ...prev]);
                            } catch (err) {
                              alert(err instanceof ApiError ? String(err.detail) : "업로드 실패");
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
                          {canDelete && (
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
              {graph && (
                <section className="local-graph">
                  <header className="section-head">
                    <h3>로컬 그래프</h3>
                    <span className="spacer" />
                    <Link to={`/projects/${project.id}/knowledge?tab=graph`} className="btn btn-sm btn-ghost">
                      전체 그래프 →
                    </Link>
                    <div className="segment">
                      {([1, 2] as const).map((d) => (
                        <button key={d} aria-pressed={graphDepth === d} onClick={() => setGraphDepth(d)}>
                          {d}단계
                        </button>
                      ))}
                    </div>
                  </header>
                  <LocalGraphView graph={graph} projectId={project.id} basePath={basePath} />
                </section>
              )}
              {links && (
                <Connections
                  links={links}
                  mentions={mentions}
                  names={[page.title, ...page.aliases]}
                  canLink={canEdit}
                  onLink={linkMentions}
                  basePath={basePath}
                  taskBase={`/projects/${project.id}/tasks`}
                  projectKey={project.key}
                />
              )}
              <WikiComments
                comments={comments}
                users={members}
                pages={pages}
                meId={me?.id}
                canCreate={canCreate}
                canEdit={canEdit}
                canAdmin={canAdmin}
                links={resolver}
                onAdd={async (body) => {
                  const created = await wikiApi.createComment(project.id, page.id, body);
                  setComments((prev) => [...prev, created]);
                }}
                onUpdate={async (id, patch) => {
                  const updated = await wikiApi.updateComment(project.id, page.id, id, patch);
                  setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
                }}
                onRemove={async (id) => {
                  await wikiApi.deleteComment(project.id, page.id, id);
                  setComments((prev) => prev.filter((c) => c.id !== id));
                }}
                onToggleReaction={async (id, emoji) => {
                  const updated = await wikiApi.toggleCommentReaction(project.id, page.id, id, emoji);
                  setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
                }}
              />
            </div>
          </>
        )}

        {page && editing && canEdit && (
          <div className="editor">
            {conflict && (
              <div className="alert tone-err wiki-conflict-bar" role="alert">
                <div className="wiki-conflict-msg">
                  <strong>편집 충돌 감지</strong> — 이 문서는 편집을 시작한 뒤 다른 곳에서 수정되었습니다 ({timeAgo(conflict.updated_at)}).
                </div>
                <div className="wiki-conflict-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setPage(conflict);
                      setDraft(toDraft(conflict));
                      setConflict(null);
                    }}
                  >
                    최신 내용 불러오기
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => save(true)}>
                    내 내용으로 덮어쓰기
                  </button>
                </div>
              </div>
            )}
            <input
              className="title-input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="제목"
            />
            <div className="alias-editor">
              <span className="muted">별칭</span>
              {draft.aliases.map((a) => (
                <span key={a} className="tag removable">
                  {a}
                  <button onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((x) => x !== a) })} aria-label={`${a} 제거`}>
                    ×
                  </button>
                </span>
              ))}
              <input
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === ",") && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addAlias();
                  }
                }}
                onBlur={addAlias}
                placeholder="다른 이름 (예: SSO) 입력 후 Enter"
              />
            </div>
            <PropertiesEditor
              value={draft}
              onChange={(v) => setDraft({ ...draft, ...v })}
              members={members}
              parentCandidates={pages.filter((p) => !collectDescendantIds(pages, page.id).has(p.id))}
            />
            <EditorSuggestBar
              match={suggest.match}
              items={suggest.items}
              index={suggest.index}
              value={draft.content}
              onPick={(next, pos) => {
                setDraft((d) => ({ ...d, content: next }));
                setEditorCursor(pos);
                requestAnimationFrame(() => editorRef.current?.setSelectionRange(pos, pos));
              }}
            />
            <MarkdownToolbar
              textareaRef={editorRef}
              value={draft.content}
              onChange={(content) => setDraft((d) => ({ ...d, content }))}
            />
            <div className="editor-split">
              <textarea
                ref={editorRef}
                value={draft.content}
                onChange={(e) => {
                  setDraft({ ...draft, content: e.target.value });
                  setEditorCursor(e.target.selectionStart ?? e.target.value.length);
                }}
                onSelect={(e) => setEditorCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
                onPaste={(e) => {
                  const img = extractImageFile(e.clipboardData);
                  if (img) {
                    e.preventDefault();
                    insertUploadedImage(project.id, img, draft.content, editorRef.current, (content) => setDraft((d) => ({ ...d, content })));
                  }
                }}
                onDrop={(e) => {
                  const img = extractImageFile(e.dataTransfer);
                  if (img) {
                    e.preventDefault();
                    insertUploadedImage(project.id, img, draft.content, editorRef.current, (content) => setDraft((d) => ({ ...d, content })));
                  }
                }}
                onKeyDown={(e) => {
                  if (
                    suggest.handleKeyDown(e, (next, pos) => {
                      setDraft((d) => ({ ...d, content: next }));
                      setEditorCursor(pos);
                      requestAnimationFrame(() => editorRef.current?.setSelectionRange(pos, pos));
                    })
                  ) {
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                    e.preventDefault();
                    save();
                  }
                }}
                placeholder="Markdown으로 작성하세요 ([[위키]] · @멘션 자동완성, 이미지 붙여넣기 지원)"
                autoFocus
              />
              <div className="editor-preview">
                <div className="editor-preview-label">미리보기</div>
                {draft.content ? <Markdown links={resolver}>{draft.content}</Markdown> : <p className="muted">입력하면 여기에 렌더링됩니다.</p>}
              </div>
            </div>
            <div className="editor-foot">
              <p className="editor-hint">
                <code>[[페이지 제목]]</code> <code>{project.key}-12</code> <code># 제목</code> <code>**굵게**</code> <code>- [ ] 체크</code>{" "}
                <code>| 표 |</code> <code>```언어</code> <code>[링크](url)</code> <code>&gt; 인용</code> · 저장{" "}
                <code>⌘S</code>
              </p>
              {canCreate && (
                <>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => imageInput.current?.click()}>
                    이미지 첨부
                  </button>
                  <input
                    ref={imageInput}
                    type="file"
                    hidden
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    onChange={(e) => {
                      const img = e.target.files?.[0];
                      if (img) insertUploadedImage(project.id, img, draft.content, editorRef.current, (content) => setDraft((d) => ({ ...d, content })));
                      e.target.value = "";
                    }}
                  />
                </>
              )}
              <button
                type="button"
                className={`btn btn-sm ${focusMode ? "btn-accent" : "btn-ghost"}`}
                aria-pressed={focusMode}
                onClick={() => setFocusMode((f) => !f)}
                title="사이드바와 트리를 접고 편집에 집중"
              >
                {focusMode ? "집중 해제" : "집중 보기"}
              </button>
              <button className="btn btn-ghost" onClick={cancelEdit}>
                취소
              </button>
              <button className="btn btn-primary" onClick={() => save()}>
                저장
              </button>
            </div>
          </div>
        )}
      </article>
      {historyOpen && page && (
        <WikiHistoryDrawer
          projectId={project.id}
          pageId={page.id}
          users={members}
          canEdit={canEdit}
          onRestored={(restored) => {
            setPage(restored);
            reloadTree();
            reloadLinks(restored.id);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

/** 문서 하단 '연결': 이 문서가 링크한 문서 · 이 문서를 링크한 문서(백링크) · 언급한 일감 */
function Connections({
  links,
  mentions,
  names,
  canLink,
  onLink,
  basePath,
  taskBase,
  projectKey,
}: {
  links: PageLinks;
  mentions: UnlinkedMention[];
  names: string[]; // 미리보기에서 강조할 제목·별칭
  canLink: boolean;
  onLink: (sources: UnlinkedMention[]) => void;
  basePath: string;
  taskBase: string;
  projectKey: string;
}) {
  const empty = !links.outgoing.length && !links.backlinks.length && !links.tasks.length && !mentions.length;
  return (
    <section className="connections">
      <h3>연결</h3>
      {empty && (
        <p className="muted">
          아직 연결이 없습니다. 본문에 <code>[[페이지 제목]]</code> 이나 <code>{projectKey}-12</code> 를 쓰면 여기에 모입니다.
        </p>
      )}
      {links.backlinks.length > 0 && (
        <div className="conn-group">
          <span className="conn-label">이 문서를 링크한 문서 {links.backlinks.length}</span>
          {links.backlinks.map((b) => (
            <Link key={b.id} to={`${basePath}/${b.id}`} className="conn-chip">
              ← {b.title}
            </Link>
          ))}
        </div>
      )}
      {links.outgoing.length > 0 && (
        <div className="conn-group">
          <span className="conn-label">이 문서가 링크한 문서 {links.outgoing.length}</span>
          {links.outgoing.map((o) =>
            o.page_id ? (
              <Link key={o.title} to={`${basePath}/${o.page_id}`} className="conn-chip">
                → {o.title}
              </Link>
            ) : (
              <span key={o.title} className="conn-chip missing" title="아직 없는 페이지">
                → {o.title}
              </span>
            ),
          )}
        </div>
      )}
      {mentions.length > 0 && (
        <div className="conn-group mentions">
          <span className="conn-label">
            링크 안 된 언급 {mentions.reduce((n, m) => n + m.count, 0)}
            {canLink && (
              <button className="btn btn-sm" onClick={() => onLink(mentions)}>
                모두 링크로 바꾸기
              </button>
            )}
          </span>
          {mentions.map((m) => (
            <div key={m.source_type + m.source_id} className="mention">
              <Link to={m.source_type === "wiki" ? `${basePath}/${m.source_id}` : `${taskBase}/${m.source_id}`} className="mention-title">
                {m.source_type === "task" ? `${projectKey}-${m.number} ` : ""}
                {m.title}
                <span className="muted"> · {m.count}곳</span>
              </Link>
              {m.snippets.map((s, i) => (
                <p key={i} className="mention-snippet">
                  {highlightNames(s, names)}
                </p>
              ))}
              {canLink && (
                <button className="btn btn-sm btn-ghost mention-link" onClick={() => onLink([m])}>
                  링크로 바꾸기
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {links.tasks.length > 0 && (
        <div className="conn-group">
          <span className="conn-label">언급한 일감 {links.tasks.length}</span>
          {links.tasks.map((t) => (
            <Link key={t.id} to={`${taskBase}/${t.id}`} className={`conn-chip task ${STAGE_TONE[t.stage]}`}>
              <span className="dot" /> {projectKey}-{t.number} {t.title}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/** 미리보기 문장에서 제목·별칭을 강조 (대소문자 무시, 긴 이름 우선) */
function highlightNames(text: string, names: string[]) {
  const alts = names.filter((n) => n.trim().length >= 2).sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alts.length) return text;
  return text.split(new RegExp(`(${alts.join("|")})`, "gi")).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

type Draft = Pick<WikiPageType, "title" | "content" | "parent_id" | "aliases" | "page_type" | "status" | "owner_id" | "tags">;

function toDraft(p: WikiPageType | null): Draft {
  return {
    title: p?.title ?? "",
    content: p?.content ?? "",
    parent_id: p?.parent_id ?? null,
    aliases: p?.aliases ?? [],
    page_type: p?.page_type ?? null,
    status: p?.status ?? null,
    owner_id: p?.owner_id ?? null,
    tags: p?.tags ?? [],
  };
}
