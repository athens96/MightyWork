import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { wikiApi } from "../../api";
import { saveBlob } from "../../api/http";
import { Avatar } from "../../components/Avatar";
import { timeAgo } from "../../lib/time";
import type { PageStatus, PageType, User, WikiPageSummary } from "../../types";
import { PAGE_STATUS_LABEL, PAGE_STATUS_TONE, PAGE_TYPE_LABEL } from "./pageProps";

const STALE_MS = 90 * 24 * 60 * 60 * 1000;
type HealthFilter = "" | "stale" | "orphan" | "broken";

function isStalePage(p: WikiPageSummary, nowMs: number): boolean {
  return p.status !== "deprecated" && nowMs - Date.parse(p.updated_at) >= STALE_MS;
}

/**
 * 위키 문서 목록 — Properties(타입·상태·담당자·태그) + 문서 건강 점검(방치·고아·깨진 링크).
 * 필터는 URL(?type=&status=&owner=&tag=&q=&health=)에 남아 링크로 공유할 수 있다.
 */
export function WikiIndex({ pages, users, basePath, projectId }: { pages: WikiPageSummary[]; users: User[]; basePath: string; projectId: string }) {
  const [params, setParams] = useSearchParams();
  const f = {
    type: params.get("type") ?? "",
    status: params.get("status") ?? "",
    owner: params.get("owner") ?? "",
    tag: params.get("tag") ?? "",
    q: params.get("q") ?? "",
    health: (params.get("health") ?? "") as HealthFilter,
  };
  const set = (key: keyof typeof f, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const nowMs = Date.now();
  const staleCount = useMemo(() => pages.filter((p) => isStalePage(p, nowMs)).length, [pages, nowMs]);
  const orphanCount = useMemo(() => pages.filter((p) => (p.backlink_count ?? 0) === 0).length, [pages]);
  const brokenCount = useMemo(() => pages.filter((p) => (p.broken_link_count ?? 0) > 0).length, [pages]);

  const allTags = useMemo(() => [...new Set(pages.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b)), [pages]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const rows = pages
    .filter(
      (p) =>
        (!f.type || (f.type === "none" ? !p.page_type : p.page_type === f.type)) &&
        (!f.status || (f.status === "none" ? !p.status : p.status === f.status)) &&
        (!f.owner || (f.owner === "none" ? !p.owner_id : p.owner_id === f.owner)) &&
        (!f.tag || p.tags.some((t) => t.toLowerCase() === f.tag.toLowerCase())) &&
        (!f.q || [p.title, ...p.aliases].some((n) => n.toLowerCase().includes(f.q.toLowerCase()))) &&
        (!f.health ||
          (f.health === "stale" && isStalePage(p, nowMs)) ||
          (f.health === "orphan" && (p.backlink_count ?? 0) === 0) ||
          (f.health === "broken" && (p.broken_link_count ?? 0) > 0)),
    )
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const filtered = Object.values(f).some(Boolean);

  return (
    <div className="wiki-index">
      <div className="pane-header">
        <span className="pane-title">
          문서 목록 {rows.length}
          {filtered && ` / ${pages.length}`}
        </span>
        {filtered && (
          <button className="btn btn-sm btn-ghost" onClick={() => setParams({}, { replace: true })}>
            필터 초기화
          </button>
        )}
        {pages.length > 0 && (
          <button
            className="btn btn-sm"
            title="모든 페이지를 폴더 구조의 .md(옵시디언 호환) + wiki.html 로"
            onClick={async () => {
              const { blob, filename } = await wikiApi.exportZip(projectId);
              saveBlob(blob, filename);
            }}
          >
            전체 ZIP
          </button>
        )}
      </div>
      <div className="index-filters">
        <input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="제목·별칭" aria-label="제목 필터" />
        <select value={f.type} onChange={(e) => set("type", e.target.value)} aria-label="타입">
          <option value="">모든 타입</option>
          {(Object.keys(PAGE_TYPE_LABEL) as PageType[]).map((t) => (
            <option key={t} value={t}>
              {PAGE_TYPE_LABEL[t]}
            </option>
          ))}
          <option value="none">미지정</option>
        </select>
        <select value={f.status} onChange={(e) => set("status", e.target.value)} aria-label="상태">
          <option value="">모든 상태</option>
          {(Object.keys(PAGE_STATUS_LABEL) as PageStatus[]).map((s) => (
            <option key={s} value={s}>
              {PAGE_STATUS_LABEL[s]}
            </option>
          ))}
          <option value="none">미지정</option>
        </select>
        <select value={f.owner} onChange={(e) => set("owner", e.target.value)} aria-label="담당자">
          <option value="">모든 담당자</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
          <option value="none">미지정</option>
        </select>
        <select value={f.tag} onChange={(e) => set("tag", e.target.value)} aria-label="태그">
          <option value="">모든 태그</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
      </div>
      {pages.length > 0 && (
        <div className="wiki-health-bar" role="group" aria-label="문서 건강 상태 점검">
          <span className="muted" style={{ fontSize: 11.5 }}>문서 점검</span>
          <button
            type="button"
            className={`btn btn-sm ${f.health === "broken" ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={f.health === "broken"}
            onClick={() => set("health", f.health === "broken" ? "" : "broken")}
            title="아직 없는 페이지를 가리키는 [[링크]]가 포함된 문서"
          >
            깨진 링크 <span className={`pill ${brokenCount > 0 ? "tone-err" : ""}`}>{brokenCount}</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${f.health === "stale" ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={f.health === "stale"}
            onClick={() => set("health", f.health === "stale" ? "" : "stale")}
            title="90일 이상 수정되지 않은 활성 문서"
          >
            방치 90일+ <span className={`pill ${staleCount > 0 ? "tone-wait" : ""}`}>{staleCount}</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${f.health === "orphan" ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={f.health === "orphan"}
            onClick={() => set("health", f.health === "orphan" ? "" : "orphan")}
            title="다른 위키 문서에서 링크되지 않은 고아 문서"
          >
            고아 문서 <span className="pill">{orphanCount}</span>
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty">{pages.length === 0 ? "아직 문서가 없습니다." : "조건에 맞는 문서가 없습니다."}</div>
      ) : (
        <table className="index-table">
          <thead>
            <tr>
              <th>제목</th>
              <th>타입</th>
              <th>상태</th>
              <th>담당자</th>
              <th>태그</th>
              <th>수정</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const owner = p.owner_id ? usersById.get(p.owner_id) : undefined;
              return (
                <tr key={p.id} className={p.status === "deprecated" ? "is-deprecated" : ""}>
                  <td>
                    <Link to={`${basePath}/${p.id}`} className="index-title">
                      {p.title}
                    </Link>
                    {p.aliases.length > 0 && <span className="muted index-alias"> · {p.aliases.join(", ")}</span>}
                    {(p.broken_link_count ?? 0) > 0 && (
                      <span className="pill tone-err" style={{ marginLeft: 6 }} title="존재하지 않는 [[위키 링크]] 포함">
                        깨진 링크 {p.broken_link_count}
                      </span>
                    )}
                    {isStalePage(p, nowMs) && (
                      <span className="pill tone-wait" style={{ marginLeft: 6 }} title="90일 이상 수정되지 않음">
                        방치 90일+
                      </span>
                    )}
                  </td>
                  <td>{p.page_type ? <span className="type-badge">{PAGE_TYPE_LABEL[p.page_type]}</span> : <span className="muted">—</span>}</td>
                  <td>{p.status ? <span className={`pill ${PAGE_STATUS_TONE[p.status]}`}>{PAGE_STATUS_LABEL[p.status]}</span> : <span className="muted">—</span>}</td>
                  <td>
                    {p.owner_id ? (
                      <span className="props-owner">
                        <Avatar user={owner} size={16} /> {owner?.name || owner?.email}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <div className="index-tags">
                      {p.tags.map((t) => (
                        <button key={t} className="tag tag-link" onClick={() => set("tag", t)}>
                          #{t}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="muted nowrap">{timeAgo(p.updated_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
