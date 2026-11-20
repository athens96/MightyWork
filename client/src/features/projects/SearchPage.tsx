import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { searchApi } from "../../api";
import { BoardIcon, DocIcon } from "../../components/icons";
import type { SearchHit } from "../../types";
import { STAGE_TONE } from "../tasks/tones";
import { useCurrentProject } from "./ProjectLayout";

/** 검색어 부분 강조 */
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {highlight(text.slice(i + q.length), q)}
    </>
  );
}

/** 프로젝트 검색 결과 (일감 + 위키). 검색어는 헤더 검색창 → ?q= */
export function SearchPage() {
  const project = useCurrentProject();
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    if (!q) return setHits([]);
    let cancelled = false;
    setHits(null);
    searchApi.search(project.id, q).then((h) => !cancelled && setHits(h), () => !cancelled && setHits([]));
    return () => {
      cancelled = true;
    };
  }, [project.id, q]);

  const tasks = hits?.filter((h) => h.kind === "task") ?? [];
  const wiki = hits?.filter((h) => h.kind === "wiki") ?? [];

  return (
    <div className="search">
      <p className="dash-sub search-summary">
        {!q ? "검색어를 입력하세요." : hits === null ? "검색 중…" : `'${q}' 검색 결과 · 일감 ${tasks.length} · 위키 ${wiki.length}`}
      </p>
      {hits && hits.length === 0 && q && <div className="card empty">일치하는 일감이나 위키가 없습니다.</div>}
      {[
        { label: "일감", items: tasks, icon: <BoardIcon size={13} /> },
        { label: "위키", items: wiki, icon: <DocIcon size={13} /> },
      ].map(
        (group) =>
          group.items.length > 0 && (
            <section key={group.label} className="search-group">
              <h3 className="group-head">
                {group.icon} {group.label} <span className="mono muted">{group.items.length}</span>
              </h3>
              <div className="card rows">
                {group.items.map((h) => (
                  <Link
                    key={h.id}
                    className="row search-row"
                    to={h.kind === "task" ? `/projects/${project.id}/tasks/${h.id}` : `/projects/${project.id}/wiki/${h.id}`}
                  >
                    {h.kind === "task" ? (
                      <span className={`key-badge ${h.stage ? STAGE_TONE[h.stage] : ""}`}>
                        {project.key}-{h.number}
                      </span>
                    ) : (
                      <span className="key-badge doc">WIKI</span>
                    )}
                    <span className="row-main">
                      <span className="row-title">{highlight(h.title, q)}</span>
                      {h.snippet && <span className="row-meta">{highlight(h.snippet, q)}</span>}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ),
      )}
    </div>
  );
}
