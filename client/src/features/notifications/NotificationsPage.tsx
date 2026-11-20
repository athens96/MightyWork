import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { notificationsApi } from "../../api";
import { timeAgo } from "../../lib/time";
import type { NotificationItem } from "../../types";

const KIND_LABEL: Record<NotificationItem["kind"], string> = {
  mention: "@멘션",
  assigned: "배정",
  comment: "덧글",
  ownership: "소유권",
  invite: "초대",
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    notificationsApi
      .list(filter === "unread")
      .then((res) => {
        setItems(res.items);
        setUnread(res.unread_count);
      })
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    reload();
  }, [reload]);

  const openItem = async (n: NotificationItem) => {
    if (!n.read) {
      await notificationsApi.markRead(n.id).catch(() => {});
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.link) navigate(n.link);
  };

  const readAll = async () => {
    await notificationsApi.markAllRead();
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    setUnread(0);
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h1 className="dash-title">알림</h1>
          <p className="dash-sub">읽지 않은 알림 {unread}건 · @멘션, 일감 배정, 덧글, 소유권 변경</p>
        </div>
        <div className="row-actions">
          <div className="segment">
            <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              전체
            </button>
            <button aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>
              안 읽음
            </button>
          </div>
          {unread > 0 && (
            <button className="btn btn-sm" onClick={readAll}>
              모두 읽음
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : items.length === 0 ? (
        <div className="card empty">표시할 알림이 없습니다.</div>
      ) : (
        <div className="card rows">
          {items.map((n) => (
            <button key={n.id} type="button" className={`row notif-row ${n.read ? "" : "is-unread"}`} onClick={() => openItem(n)}>
              <span className={`pill ${n.read ? "tone-stop" : "tone-run"}`}>{KIND_LABEL[n.kind]}</span>
              <span className="row-main">
                <span className="row-title">{n.title}</span>
                {n.body && <span className="row-meta">{n.body}</span>}
              </span>
              <span className="muted nowrap">{timeAgo(n.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
