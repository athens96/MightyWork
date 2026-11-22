import { useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "../../components/Avatar";
import { EditorSuggestBar, useEditorSuggest } from "../../components/EditorSuggest";
import { Markdown } from "../../components/Markdown";
import { ReactionBar } from "../../components/ReactionBar";
import { formatDate, timeAgo } from "../../lib/time";
import type { Comment, PipelineStageInfo, Priority, TaskActivity, User, WikiPageSummary } from "../../types";
import type { LinkResolver } from "../../lib/wikilinks";
import { FIELD_LABEL, PRIORITY_LABEL } from "./tones";

interface Props {
  comments: Comment[];
  activity: TaskActivity[];
  users: User[];
  pages?: WikiPageSummary[];
  stages: PipelineStageInfo[];
  meId: string | undefined;
  canComment: boolean; // 생성 권한
  canModerate: boolean; // 관리자: 남의 덧글 삭제 가능
  links?: LinkResolver; // [[위키]]·일감 키 링크
  onAdd: (body: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onToggleReaction?: (id: string, emoji: string) => Promise<void>;
}

type Entry = { at: string; comment?: Comment; act?: TaskActivity };

/** 덧글 + 변경 이력 타임라인, 하단 덧글 입력창(컴포저) */
export function TaskTimeline({ comments, activity, users, pages = [], stages, meId, canComment, canModerate, links, onAdd, onEdit, onRemove, onToggleReaction }: Props) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [show, setShow] = useState<"all" | "comments">("all");
  const suggest = useEditorSuggest(draft, cursor, pages, users);
  const userOf = (id: string) => users.find((u) => u.id === id);
  const nameOf = (id: string) => userOf(id)?.name || userOf(id)?.email || "알 수 없음";

  const fmt = (field: string | null, v: unknown): string => {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return "없음";
    switch (field) {
      case "stage":
        return stages.find((s) => s.key === v)?.label ?? String(v);
      case "priority":
        return PRIORITY_LABEL[v as Priority] ?? String(v);
      case "assignee_id":
        return nameOf(String(v));
      case "start_date":
      case "due_date":
        return formatDate(String(v));
      case "estimate":
        return `${v}pt`;
      case "tags":
        return (v as string[]).join(", ");
      default:
        return String(v);
    }
  };

  const entries: Entry[] = [
    ...comments.map((c) => ({ at: c.created_at, comment: c })),
    ...(show === "all" ? activity.map((a) => ({ at: a.created_at, act: a })) : []),
  ].sort((a, b) => a.at.localeCompare(b.at));

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
    <section className="detail-section">
      <header className="section-head">
        <h3>활동</h3>
        <span className="spacer" />
        <div className="segment">
          <button aria-pressed={show === "all"} onClick={() => setShow("all")}>
            전체
          </button>
          <button aria-pressed={show === "comments"} onClick={() => setShow("comments")}>
            덧글 {comments.length}
          </button>
        </div>
      </header>

      <ol className="timeline">
        {entries.map(({ comment, act }) =>
          comment ? (
            <li key={comment.id} className="tl-comment">
              <Avatar user={userOf(comment.author_id)} size={24} />
              <div className="bubble">
                <div className="bubble-head">
                  <strong>{nameOf(comment.author_id)}</strong>
                  {comment.via_client && (
                    <span className="pill tone-agent agent-via" title={`MCP 클라이언트(${comment.via_client})를 통해 작성됨`}>
                      via {comment.via_client}
                    </span>
                  )}
                  <span className="muted">
                    {timeAgo(comment.created_at)}
                    {Date.parse(comment.updated_at) - Date.parse(comment.created_at) > 1000 && " · 수정됨"}
                  </span>
                  {(comment.author_id === meId || canModerate) && editing?.id !== comment.id && (
                    <span className="bubble-actions">
                      {comment.author_id === meId && (
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ id: comment.id, body: comment.body })}>
                          수정
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-ghost btn-danger"
                        onClick={() => confirm("덧글을 삭제할까요?") && onRemove(comment.id)}
                      >
                        삭제
                      </button>
                    </span>
                  )}
                </div>
                {editing?.id === comment.id ? (
                  <div className="composer inline">
                    <textarea
                      autoFocus
                      value={editing.body}
                      onChange={(e) => setEditing({ id: comment.id, body: e.target.value })}
                      onKeyDown={(e) => submitOnCmdEnter(e, () => onEdit(comment.id, editing.body).then(() => setEditing(null)))}
                    />
                    <div className="composer-foot">
                      <span className="spacer" />
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                        취소
                      </button>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={!editing.body.trim()}
                        onClick={() => onEdit(comment.id, editing.body).then(() => setEditing(null))}
                      >
                        저장
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Markdown className="bubble-body" links={links}>
                      {comment.body}
                    </Markdown>
                    {onToggleReaction && (
                      <ReactionBar
                        reactions={comment.reactions}
                        meId={meId}
                        users={users}
                        onToggle={(emoji) => onToggleReaction(comment.id, emoji)}
                      />
                    )}
                  </>
                )}
              </div>
            </li>
          ) : (
            act && (
              <li key={act.id} className="tl-event">
                <span className="tl-dot" />
                <span>
                  <strong>{nameOf(act.actor_id)}</strong>
                  {act.via_client && (
                    <span className="pill tone-agent agent-via" style={{ marginLeft: 5 }} title={`MCP 클라이언트(${act.via_client})를 통해 실행됨`}>
                      via {act.via_client}
                    </span>
                  )}{" "}
                  {act.kind === "created" ? (
                    "일감을 만들었습니다"
                  ) : (
                    <>
                      {FIELD_LABEL[act.field ?? ""] ?? act.field} 변경 <span className="from">{fmt(act.field, act.old)}</span> →{" "}
                      <span className="to">{fmt(act.field, act.new)}</span>
                    </>
                  )}
                </span>
                <span className="muted tl-time">{timeAgo(act.created_at)}</span>
              </li>
            )
          ),
        )}
      </ol>

      {!canComment ? (
        <p className="muted readonly-note">생성 권한이 있어야 덧글을 남길 수 있습니다.</p>
      ) : (
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
          placeholder="덧글을 남기세요 ([[위키]], @멘션, Markdown 지원)"
          rows={3}
        />
        <div className="composer-foot">
          <span className="muted hint">@멘션 · [[위키]] 자동완성 · ⌘ Enter 로 등록</span>
          <span className="spacer" />
          <button className="btn btn-sm btn-primary" disabled={!draft.trim() || sending} onClick={submit}>
            덧글 남기기
          </button>
        </div>
      </div>
      )}
    </section>
  );
}
