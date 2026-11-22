import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trashApi, usersApi } from "../../api";
import { BoardIcon, DocIcon } from "../../components/icons";
import { can } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import type { TrashItem, User } from "../../types";
import { useCurrentProject } from "./ProjectLayout";

/** 프로젝트 휴지통 — 삭제된 일감·위키 30일 보관, 원클릭 복구 및 영구 삭제 */
export function TrashPage() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const canEdit = can(project, "edit");
  const canDelete = can(project, "delete");
  const canAdmin = can(project, "admin");
  const [items, setItems] = useState<TrashItem[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, u] = await Promise.all([trashApi.list(project.id), usersApi.listByProject(project.id).catch(() => [] as User[])]);
      setItems(list);
      setUsers(u);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const nameOf = (id: string | null) => {
    if (!id) return "—";
    const u = users.find((x) => x.id === id);
    return u?.name || u?.email || "알 수 없음";
  };

  const restore = async (item: TrashItem) => {
    setBusyId(item.id);
    try {
      await trashApi.restore(project.id, item.kind, item.id);
      setItems((prev) => prev.filter((x) => !(x.kind === item.kind && x.id === item.id)));
      navigate(item.kind === "task" ? `/projects/${project.id}/tasks/${item.id}` : `/projects/${project.id}/wiki/${item.id}`);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (item: TrashItem) => {
    if (!confirm(`"${item.title}" 항목을 영구 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
    setBusyId(item.id);
    try {
      await trashApi.purge(project.id, item.kind, item.id);
      setItems((prev) => prev.filter((x) => !(x.kind === item.kind && x.id === item.id)));
    } finally {
      setBusyId(null);
    }
  };

  const emptyAll = async () => {
    if (!confirm(`휴지통의 모든 항목 ${items.length}건을 영구 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
    await trashApi.empty(project.id);
    setItems([]);
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>휴지통</h2>
          <p className="dash-sub">삭제한 일감과 위키 문서는 30일간 보관된 뒤 자동으로 영구 삭제됩니다.</p>
        </div>
        <div className="row-actions">
          {canAdmin && items.length > 0 && (
            <button type="button" className="btn btn-sm btn-danger" onClick={emptyAll}>
              휴지통 비우기 ({items.length})
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : items.length === 0 ? (
        <div className="card empty">휴지통이 비어 있습니다.</div>
      ) : (
        <div className="card list-view-card">
          <table className="index-table">
            <thead>
              <tr>
                <th>종류</th>
                <th>제목</th>
                <th>삭제한 사람</th>
                <th>삭제 시각</th>
                <th>남은 보관</th>
                <th style={{ width: 160 }}>작업</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.kind}:${item.id}`}>
                  <td className="nowrap">
                    <span className="pill">
                      {item.kind === "task" ? <BoardIcon size={11} /> : <DocIcon size={11} />}{" "}
                      {item.kind === "task" ? `${project.key}-${item.number}` : "위키"}
                    </span>
                  </td>
                  <td>
                    <strong>{item.title}</strong>
                  </td>
                  <td className="nowrap muted">{nameOf(item.deleted_by)}</td>
                  <td className="nowrap muted">{timeAgo(item.deleted_at)}</td>
                  <td className="nowrap">
                    <span className={`pill ${item.days_left <= 5 ? "tone-err" : "tone-stop"}`}>D-{item.days_left}</span>
                  </td>
                  <td className="nowrap">
                    <div className="row" style={{ gap: 6 }}>
                      {canEdit && (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busyId === item.id}
                          onClick={() => restore(item)}
                        >
                          복구
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost btn-danger"
                          disabled={busyId === item.id}
                          onClick={() => purge(item)}
                        >
                          영구 삭제
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
