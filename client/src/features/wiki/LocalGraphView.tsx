import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LocalGraph } from "../../types";

const W = 760;
const H = 340;
const CX = W / 2;
const CY = H / 2;

const STAGE_COLOR: Record<string, string> = {
  backlog: "var(--stop)",
  todo: "var(--ink3)",
  in_progress: "var(--run)",
  review: "var(--agent)",
  qa: "var(--task)",
  done: "var(--done)",
};

const short = (s: string, n = 12) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * 로컬 그래프 (옵시디언 Local graph): 중심 문서 → 1단계(안쪽 원) → 2단계(바깥 원).
 * 2단계 노드는 처음 연결된 1단계 노드 근처에 모아 배치한다. 외부 라이브러리 없이 SVG.
 */
export function LocalGraphView({ graph, projectId, basePath }: { graph: LocalGraph; projectId: string; basePath: string }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);

  const pos = useMemo(() => {
    const p = new Map<string, { x: number; y: number; angle: number }>();
    p.set(graph.center, { x: CX, y: CY, angle: 0 });
    const d1 = graph.nodes.filter((n) => n.depth === 1);
    d1.forEach((n, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(d1.length, 1);
      p.set(n.id, { x: CX + Math.cos(angle) * 150, y: CY + Math.sin(angle) * 92, angle });
    });
    // 2단계: 연결된 1단계 노드별로 묶어 그 각도 주변에 펼침
    const groups = new Map<string, string[]>();
    for (const n of graph.nodes.filter((n) => n.depth === 2)) {
      const parent = graph.edges
        .flatMap((e) => (e.source === n.id ? [e.target] : e.target === n.id ? [e.source] : []))
        .find((id) => d1.some((x) => x.id === id));
      const key = parent ?? graph.center;
      groups.set(key, [...(groups.get(key) ?? []), n.id]);
    }
    const slot = (2 * Math.PI) / Math.max(d1.length, 1);
    for (const [parent, ids] of groups) {
      const base = p.get(parent)?.angle ?? 0;
      const spread = Math.min(slot * 0.8, 1.1);
      ids.forEach((id, i) => {
        const angle = base + (ids.length === 1 ? 0 : -spread / 2 + (spread * i) / (ids.length - 1));
        p.set(id, { x: CX + Math.cos(angle) * 300, y: CY + Math.sin(angle) * 138, angle });
      });
    }
    return p;
  }, [graph]);

  const linked = (id: string) =>
    !hover || id === hover || graph.edges.some((e) => (e.source === hover && e.target === id) || (e.target === hover && e.source === id));

  if (graph.nodes.length <= 1) {
    return <p className="muted graph-empty">연결된 문서나 일감이 없습니다. 본문에 [[링크]] 나 일감 키를 쓰면 그래프가 생깁니다.</p>;
  }

  return (
    <div className="graph-canvas">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="로컬 그래프">
        {graph.edges.map((e) => {
          const a = pos.get(e.source);
          const b = pos.get(e.target);
          if (!a || !b) return null;
          const on = !hover || e.source === hover || e.target === hover;
          return (
            <line
              key={`${e.source}-${e.target}-${e.kind}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={`g-edge ${e.kind}`}
              opacity={on ? 1 : 0.12}
            />
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const center = n.id === graph.center;
          const href = n.kind === "wiki" ? `${basePath}/${n.ref_id}` : `/projects/${projectId}/tasks/${n.ref_id}`;
          return (
            <g
              key={n.id}
              className={`g-node ${n.kind} ${center ? "center" : ""} ${n.status === "deprecated" ? "deprecated" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              opacity={linked(n.id) ? 1 : 0.25}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => !center && navigate(href)}
              role={center ? undefined : "link"}
            >
              <title>{n.kind === "task" ? `일감 #${n.number} ${n.label}` : n.label}</title>
              {n.kind === "wiki" ? (
                <circle r={center ? 13 : 9} />
              ) : (
                <rect x={-8} y={-8} width={16} height={16} rx={4} style={{ fill: STAGE_COLOR[n.status ?? ""] ?? "var(--stop)" }} />
              )}
              <text y={center ? 28 : 23} textAnchor="middle">
                {n.kind === "task" ? `#${n.number} ` : ""}
                {short(n.label, center ? 18 : 12)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="graph-legend">
        <span>
          <i className="lg-wiki" /> 위키
        </span>
        <span>
          <i className="lg-task" /> 일감
        </span>
        <span>
          <i className="lg-line" /> 링크
        </span>
        <span>
          <i className="lg-line lg-mention" /> 일감 언급
        </span>
        <span>
          <i className="lg-line lg-parent" /> 상하위
        </span>
        {graph.truncated && <span className="muted">· 노드가 많아 일부만 표시</span>}
      </div>
    </div>
  );
}
