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
import { ChevronIcon, EditIcon, HistoryIcon, PaperclipIcon, PlusIcon, TrashIcon } from "../../components/icons";
import { Markdown, TableOfContents } from "../../components/Markdown";
import { MarkdownToolbar } from "../../components/MarkdownToolbar";
import { extractHeadings } from "../../lib/markdownHelpers";
import { can } from "../../lib/permissions";
import { PROJECT_EVENT, type ProjectEventDetail } from "../../lib/sse";
import { extractImageFile, insertUploadedImage } from "../../lib/editorUpload";
import { timeAgo, todayYmd } from "../../lib/time";
import { useLinkResolver } from "../../lib/useLinkResolver";
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
  const [tplOpen, setTplOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selectionPop, setSelectionPop] = useState<{ text: string; top: number; left: number } | null>(null);
  const [createdNotice, setCreatedNotice] = useState<{ id: string; key: string; title: string } | null>(null);
  const mdWrapRef = useRef<HTMLDivElement>(null);
  const suggest = useEditorSuggest(draft.content, editorCursor, pages, members);

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

  // 실시간 위키 댓글 갱신 (SSE)
  useEffect(() => {
    if (!pageId) return;
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<ProjectEventDetail>).detail;
      if (!detail || detail.projectId !== project.id || detail.data.page_id !== pageId) return;
      if (detail.event.startsWith("wiki.comment_")) {
        wikiApi.listComments(project.id, pageId).then(setComments, () => {});
      }
    };
    window.addEventListener(PROJECT_EVENT, onEvent);
    return () => window.removeEventListener(PROJECT_EVENT, onEvent);
  }, [project.id, pageId]);

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

  const startEdit = () => {
    if (!page) return;
    setDraft(toDraft(page));
    setConflict(null);
    setEditing(true);
  };

  const save = async (force = false) => {
    if (!page) return;
    setConflict(null);
    try {
      const payload = force ? draft : { ...draft, expected_updated_at: page.updated_at };
      const updated = await wikiApi.update(project.id, page.id, payload);
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
    if (!page || !confirm(`"${page.title}" 페이지를 삭제할까요?`)) return;
    try {
      await wikiApi.remove(project.id, page.id);
      await reloadTree();
      navigate(basePath);
    } catch (e) {
      alert(e instanceof ApiError && e.status === 409 ? "하위 페이지를 먼저 삭제하거나 옮겨주세요." : "삭제 실패");
    }
  };

  return (
    <div className="wiki">
      <aside className={`pane wiki-nav ${pageId && !navOpen ? "is-collapsed-mobile" : ""}`}>
        <div className="pane-header">
          <span className="pane-title">페이지 {pages.length}</span>
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
        {!pageId && <WikiIndex pages={pages} users={members} basePath={basePath} projectId={project.id} />}
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
              <button className="btn btn-ghost" onClick={() => { setConflict(null); setEditing(false); }}>
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
