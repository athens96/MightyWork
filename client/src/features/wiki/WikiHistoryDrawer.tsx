import { useEffect, useState } from "react";
import { wikiApi } from "../../api";
import { CloseIcon } from "../../components/icons";
import { timeAgo } from "../../lib/time";
import type { User, WikiPage, WikiRevisionDetail, WikiRevisionSummary } from "../../types";

interface Props {
  projectId: string;
  pageId: string;
  users: User[];
  canEdit: boolean;
  onRestored: (page: WikiPage) => void;
  onClose: () => void;
}

/** 위키 버전 히스토리 패널 — 버전 목록, 현재 문서 대비 줄 Diff, 원클릭 복원 */
export function WikiHistoryDrawer({ projectId, pageId, users, canEdit, onRestored, onClose }: Props) {
  const [revisions, setRevisions] = useState<WikiRevisionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WikiRevisionDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    wikiApi.revisions(projectId, pageId).then((list) => {
      setRevisions(list);
      if (list.length > 0) setSelectedId(list[0].id);
    });
  }, [projectId, pageId]);

  useEffect(() => {
    if (!selectedId) return setDetail(null);
    wikiApi.revision(projectId, pageId, selectedId).then(setDetail);
  }, [projectId, pageId, selectedId]);

  const userName = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u?.name || u?.email || "알 수 없음";
  };

  const restore = async () => {
    if (!detail || !confirm(`v${detail.version} ("${detail.title}") 버전으로 복원할까요?\n현재 내용은 히스토리에 남습니다.`)) return;
    setBusy(true);
    try {
      const restored = await wikiApi.restore(projectId, pageId, detail.id);
      onRestored(restored);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <section className="sheet history-sheet" role="dialog" aria-modal="true" aria-label="버전 히스토리">
        <header className="sheet-head">
          <span className="key-badge">HISTORY</span>
          <span className="sheet-title">버전 히스토리 ({revisions.length})</span>
          <button className="icon-btn" onClick={onClose} title="닫기">
            <CloseIcon size={13} />
          </button>
        </header>
        <div className="history-body">
          <aside className="history-list">
            {revisions.length === 0 ? (
              <p className="muted">기록된 버전이 없습니다.</p>
            ) : (
              revisions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`history-item ${selectedId === r.id ? "active" : ""}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="history-item-head">
                    <strong>v{r.version}</strong>
                    <span className="muted">{timeAgo(r.created_at)}</span>
                  </div>
                  <div className="history-item-title">{r.title}</div>
                  <div className="muted history-item-meta">
                    {userName(r.editor_id)}
                    {r.note ? ` · ${r.note}` : ""}
                  </div>
                </button>
              ))
            )}
          </aside>
          <div className="history-preview">
            {detail ? (
              <>
                <div className="history-preview-head">
                  <div>
                    <h3>
                      v{detail.version} · {detail.title}
                    </h3>
                    <p className="muted">
                      {userName(detail.editor_id)} · {timeAgo(detail.created_at)}
                      {detail.note ? ` · ${detail.note}` : ""}
                    </p>
                  </div>
                  {canEdit && (
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={restore}>
                      {busy ? "복원 중…" : "이 버전으로 복원"}
                    </button>
                  )}
                </div>
                <div className="diff-label">현재 버전과의 차이 (- 선택한 버전 / + 현재 버전)</div>
                <pre className="diff-view">
                  {detail.diff_to_current.length === 0 ? (
                    <span className="muted">(내용 없음)</span>
                  ) : (
                    detail.diff_to_current.map((line, i) => (
                      <div key={i} className={`diff-line diff-${line.kind}`}>
                        <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                        <span>{line.text || " "}</span>
                      </div>
                    ))
                  )}
                </pre>
              </>
            ) : (
              <p className="muted">왼쪽에서 버전을 선택하세요.</p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
