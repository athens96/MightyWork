import { useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "../../components/Avatar";
import { EditorSuggestBar, useEditorSuggest } from "../../components/EditorSuggest";
import { Markdown } from "../../components/Markdown";
import { ReactionBar } from "../../components/ReactionBar";
import { timeAgo } from "../../lib/time";
import type { LinkResolver } from "../../lib/wikilinks";
import type { User, WikiComment, WikiPageSummary } from "../../types";

interface Props {
  comments: WikiComment[];
  users: User[];
  pages: WikiPageSummary[];
  meId: string | undefined;
  canCreate: boolean;
  canEdit: boolean;
  canAdmin: boolean;
  links?: LinkResolver;
  onAdd: (body: string) => Promise<void>;
  onUpdate: (id: string, patch: { body?: string; resolved?: boolean }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onToggleReaction?: (id: string, emoji: string) => Promise<void>;
}

/** 위키 페이지 하단 토론 댓글 (해결/재오픈 토글 · 이모지 리액션 · @멘션 · [[위키]] 지원) */
export function WikiComments({
  comments,
  users,
  pages,
  meId,
  canCreate,
  canEdit,
  canAdmin,
  links,
  onAdd,
  onUpdate,
  onRemove,
  onToggleReaction,
}: Props) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const suggest = useEditorSuggest(draft, cursor, pages, users);

  const userOf = (id: string | null) => (id ? users.find((u) => u.id === id) : undefined);
  const nameOf = (id: string | null) => userOf(id)?.name || userOf(id)?.email || "알 수 없음";

  const openCount = comments.filter((c) => !c.resolved).length;
  const visible = filter === "all" ? comments : comments.filter((c) => !c.resolved);

  const submit = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await onAdd(draft.trim());
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  const submitOnCmdEnter = (e: KeyboardEvent<HTMLTextAreaElement>, action: () => void) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      action();
    }
  };

  return (
    <section className="wiki-comments">
      <header className="section-head">
        <h3>
          토론 댓글 {openCount > 0 ? `${openCount}` : comments.length > 0 ? `0 / ${comments.length}` : ""}
        </h3>
        <span className="spacer" />
        {comments.length > 0 && (
          <div className="segment">
            <button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
              열림 {openCount}
            </button>
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              전체 {comments.length}
            </button>
          </div>
        )}
      </header>

      {visible.length === 0 ? (
        <p className="muted wiki-comments-empty">
          {comments.length === 0
            ? "아직 댓글이 없습니다. 문서에 대한 질문이나 리뷰 의견을 남겨보세요."
            : "열려 있는 댓글이 없습니다. '전체'에서 해결된 토론을 볼 수 있습니다."}
        </p>
      ) : (
        <ol className="timeline">
          {visible.map((c) => {
            const isMine = c.author_id === meId;
            const canResolve = isMine || canEdit;
            const canDelete = isMine || canAdmin;
            return (
              <li key={c.id} className={`tl-comment${c.resolved ? " is-resolved" : ""}`}>
                <Avatar user={userOf(c.author_id)} size={24} />
                <div className="bubble">
                  <div className="bubble-head">
                    <strong>{nameOf(c.author_id)}</strong>
                    {c.resolved && (
                      <span className="pill tone-done" title={c.resolved_by ? `${nameOf(c.resolved_by)} 해결` : "해결됨"}>
                        해결됨
                      </span>
                    )}
                    <span className="muted">
                      {timeAgo(c.created_at)}
                      {Date.parse(c.updated_at) - Date.parse(c.created_at) > 1000 && " · 수정됨"}
                    </span>
                    {editing?.id !== c.id && (
                      <span className="bubble-actions">
                        {canResolve && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => onUpdate(c.id, { resolved: !c.resolved })}
                          >
                            {c.resolved ? "재오픈" : "해결"}
                          </button>
                        )}
                        {isMine && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setEditing({ id: c.id, body: c.body })}
                          >
                            수정
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost btn-danger"
                            onClick={() => confirm("댓글을 삭제할까요?") && onRemove(c.id)}
                          >
                            삭제
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {editing?.id === c.id ? (
                    <div className="composer inline">
                      <textarea
                        autoFocus
                        value={editing.body}
                        onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                        onKeyDown={(e) =>
                          submitOnCmdEnter(e, () => onUpdate(c.id, { body: editing.body }).then(() => setEditing(null)))
                        }
                      />
                      <div className="composer-foot">
                        <span className="spacer" />
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                          취소
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={!editing.body.trim()}
                          onClick={() => onUpdate(c.id, { body: editing.body }).then(() => setEditing(null))}
                        >
                          저장
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Markdown className="bubble-body" links={links}>
                        {c.body}
                      </Markdown>
                      {onToggleReaction && (
                        <ReactionBar
                          reactions={c.reactions}
                          meId={meId}
                          users={users}
                          onToggle={(emoji) => onToggleReaction(c.id, emoji)}
                        />
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canCreate && (
        <div className="composer">
          <EditorSuggestBar
            match={suggest.match}
            items={suggest.items}
            index={suggest.index}
            value={draft}
            onPick={(next, pos) => {
              setDraft(next);
              setCursor(pos);
              requestAnimationFrame(() => composerRef.current?.setSelectionRange(pos, pos));
            }}
          />
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (
                suggest.handleKeyDown(e, (next, pos) => {
                  setDraft(next);
                  setCursor(pos);
                  requestAnimationFrame(() => composerRef.current?.setSelectionRange(pos, pos));
                })
              ) {
                return;
              }
              submitOnCmdEnter(e, submit);
            }}
            placeholder="문서에 대한 댓글을 남기세요 (@멘션 · [[위키]] · Markdown 지원)"
            rows={2}
          />
          <div className="composer-foot">
            <span className="muted hint">@멘션 · [[위키]] 자동완성 · ⌘ Enter 로 등록</span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm btn-primary" disabled={!draft.trim() || sending} onClick={submit}>
              댓글 남기기
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
