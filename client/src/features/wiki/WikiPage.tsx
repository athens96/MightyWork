import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { membersApi, wikiApi } from "../../api";
import { ApiError } from "../../api/http";
import type { PageLinks, UnlinkedMention, User, WikiPage as WikiPageType, WikiPageSummary } from "../../types";
import { PropertiesBar, PropertiesEditor } from "./pageProps";
import { WikiIndex } from "./WikiIndex";
import { useCurrentProject } from "../projects/ProjectLayout";
import { ChevronIcon, EditIcon, PlusIcon, TrashIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { can } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import { useLinkResolver } from "../../lib/useLinkResolver";
import { STAGE_TONE } from "../tasks/tones";
import { WikiTree } from "./WikiTree";

export function WikiPage() {
  const project = useCurrentProject();
  const basePath = `/projects/${project.id}/wiki`;
  const canCreate = can(project, "create");
  const canEdit = can(project, "edit");
  const canDelete = can(project, "delete");
  const { pageId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [page, setPage] = useState<WikiPageType | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [members, setMembers] = useState<User[]>([]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [mentions, setMentions] = useState<UnlinkedMention[]>([]);
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
      ]),
    [project.id],
  );
  useEffect(() => {
    setLinks(null);
    setMentions([]);
    if (pageId) reloadLinks(pageId);
  }, [pageId, reloadLinks]);

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
    setEditing(true);
  };

  const save = async () => {
    if (!page) return;
    const updated = await wikiApi.update(project.id, page.id, draft);
    setPage(updated);
    setEditing(false);
    reloadTree();
    reloadLinks(updated.id);
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
      <aside className="pane wiki-nav">
        <div className="pane-header">
          <span className="pane-title">페이지 {pages.length}</span>
          <Link to={basePath} className="btn btn-sm btn-ghost" title="문서 목록 (속성으로 거르기)">
            목록
          </Link>
          {canCreate && (
            <button className="icon-btn" onClick={() => createPage(null)} title="새 페이지">
              <PlusIcon size={12} />
            </button>
          )}
        </div>
        <div className="tree-wrap">
          {pages.length === 0 ? (
            <p className="wiki-empty-nav">아직 페이지가 없습니다.{canCreate && " + 를 눌러 첫 페이지를 만드세요."}</p>
          ) : (
            <WikiTree pages={pages} basePath={basePath} />
          )}
        </div>
      </aside>

      <article className="pane wiki-body">
        {!pageId && <WikiIndex pages={pages} users={members} basePath={basePath} />}
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
              {page.content ? (
                <Markdown links={resolver}>{page.content}</Markdown>
              ) : (
                <p className="muted">내용 없음{canEdit && " — 편집을 눌러 작성하세요."}</p>
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
            </div>
          </>
        )}

        {page && editing && canEdit && (
          <div className="editor">
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
            <PropertiesEditor value={draft} onChange={(v) => setDraft({ ...draft, ...v })} members={members} />
            <div className="editor-split">
              <textarea
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                    e.preventDefault();
                    save();
                  }
                }}
                placeholder="Markdown으로 작성하세요"
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
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                취소
              </button>
              <button className="btn btn-primary" onClick={save}>
                저장
              </button>
            </div>
          </div>
        )}
      </article>
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

type Draft = Pick<WikiPageType, "title" | "content" | "aliases" | "page_type" | "status" | "owner_id" | "tags">;

function toDraft(p: WikiPageType | null): Draft {
  return {
    title: p?.title ?? "",
    content: p?.content ?? "",
    aliases: p?.aliases ?? [],
    page_type: p?.page_type ?? null,
    status: p?.status ?? null,
    owner_id: p?.owner_id ?? null,
    tags: p?.tags ?? [],
  };
}
