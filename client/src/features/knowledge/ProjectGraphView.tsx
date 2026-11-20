import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphEdge, GraphNode } from "../../types";

const W = 920;
const H = 520;
const CX = W / 2;
const CY = H / 2;

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  wiki: "위키",
  task: "일감",
  glossary: "용어",
  entity: "엔티티",
};

const short = (s: string, n = 14) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 프로젝트 전체 그래프 뷰 (외부 라이브러리 없는 SVG, 줌·검색 강조·종류 필터·클릭 이동) */
export function ProjectGraphView({
  nodes,
  edges,
  projectId,
  compact = false,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  projectId: string;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [filterText, setFilterText] = useState("");
  const [visibleKinds, setVisibleKinds] = useState<Record<GraphNode["kind"], boolean>>({
    wiki: true,
    task: true,
    glossary: true,
    entity: true,
  });

  const filteredNodes = useMemo(() => nodes.filter((n) => visibleKinds[n.kind]), [nodes, visibleKinds]);
  const keptIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)), [edges, keptIds]);

  // 종류·연결도 기반 결정적 원형/다중 링 레이아웃 (매 렌더링 안정적)
  const pos = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const deg = new Map<string, number>();
    for (const e of filteredEdges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    const sorted = [...filteredNodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.kind.localeCompare(b.kind));
    if (sorted.length === 0) return map;
    if (sorted.length === 1) {
      map.set(sorted[0].id, { x: CX, y: CY });
      return map;
    }
    const rings = [10, 22, 38, 60, 120];
    let idx = 0;
    let ringIdx = 0;
    while (idx < sorted.length) {
      const cap = rings[Math.min(ringIdx, rings.length - 1)];
      const slice = sorted.slice(idx, idx + cap);
      const rx = Math.min(390, 95 + ringIdx * 82);
      const ry = Math.min(215, 62 + ringIdx * 48);
      slice.forEach((n, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / slice.length + ringIdx * 0.25;
        map.set(n.id, { x: CX + Math.cos(angle) * rx, y: CY + Math.sin(angle) * ry });
      });
      idx += slice.length;
      ringIdx++;
    }
    return map;
  }, [filteredNodes, filteredEdges]);

  const q = filterText.trim().toLowerCase();
  const isHighlighted = (n: GraphNode) => (!q || n.label.toLowerCase().includes(q));
  const isLinked = (id: string) =>
    !hover || id === hover || filteredEdges.some((e) => (e.source === hover && e.target === id) || (e.target === hover && e.source === id));

  const go = (n: GraphNode) => {
    if (n.kind === "wiki") navigate(`/projects/${projectId}/wiki/${n.ref_id}`);
    else if (n.kind === "task") navigate(`/projects/${projectId}/tasks/${n.ref_id}`);
    else if (n.kind === "glossary") navigate(`/projects/${projectId}/knowledge?tab=glossary`);
    else navigate(`/projects/${projectId}/knowledge?tab=review`);
  };

  if (nodes.length === 0) {
    return <div className="card empty">아직 그래프에 표시할 노드가 없습니다.</div>;
  }

  return (
    <div className="full-graph-wrap">
      {!compact && (
        <div className="graph-toolbar">
          <input value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder="노드 이름 강조…" />
          <div className="graph-kind-toggles">
            {(Object.keys(KIND_LABEL) as GraphNode["kind"][]).map((k) => (
              <label key={k} className="kind-toggle">
                <input
                  type="checkbox"
                  checked={visibleKinds[k]}
                  onChange={(e) => setVisibleKinds((v) => ({ ...v, [k]: e.target.checked }))}
                />
                {KIND_LABEL[k]} ({nodes.filter((n) => n.kind === k).length})
              </label>
            ))}
          </div>
          <span className="spacer" />
          <div className="segment">
            <button onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))}>-</button>
            <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.2).toFixed(1)))}>+</button>
          </div>
        </div>
      )}
      <div className="graph-canvas">
        <svg viewBox={`0 0 ${W} ${compact ? 360 : H}`} role="img" aria-label="프로젝트 전체 지식 그래프">
          <g transform={`translate(${CX * (1 - zoom)}, ${(compact ? 180 : CY) * (1 - zoom)}) scale(${zoom})`}>
            {filteredEdges.map((e, i) => {
              const a = pos.get(e.source);
              const b = pos.get(e.target);
              if (!a || !b) return null;
              const on = !hover || e.source === hover || e.target === hover;
              return (
                <line
                  key={`${e.source}-${e.target}-${e.kind}-${i}`}
                  x1={a.x}
                  y1={compact ? a.y * 0.68 : a.y}
                  x2={b.x}
                  y2={compact ? b.y * 0.68 : b.y}
                  className={`g-edge ${e.kind}`}
                  opacity={on ? 0.85 : 0.1}
                />
              );
            })}
            {filteredNodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const y = compact ? p.y * 0.68 : p.y;
              const active = isLinked(n.id) && isHighlighted(n);
              return (
                <g
                  key={n.id}
                  className={`g-node ${n.kind}`}
                  transform={`translate(${p.x},${y})`}
                  opacity={active ? 1 : 0.2}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => go(n)}
                  role="link"
                >
                  <title>{`${KIND_LABEL[n.kind]} · ${n.kind === "task" && n.number ? `#${n.number} ` : ""}${n.label}${n.status ? ` (${n.status})` : ""}`}</title>
                  {n.kind === "wiki" && <circle r={10} />}
                  {n.kind === "task" && <rect x={-8} y={-8} width={16} height={16} rx={4} className="g-task-shape" />}
                  {n.kind === "glossary" && <polygon points="0,-10 10,0 0,10 -10,0" className="g-glossary-shape" />}
                  {n.kind === "entity" && <polygon points="0,-11 10,-5 10,5 0,11 -10,5 -10,-5" className="g-entity-shape" />}
                  <text y={22} textAnchor="middle">
                    {n.kind === "task" && n.number ? `#${n.number} ` : ""}
                    {short(n.label)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="graph-legend">
          <span><i className="lg-wiki" /> 위키</span>
          <span><i className="lg-task" /> 일감</span>
          <span><i className="lg-glossary" /> 용어집</span>
          <span><i className="lg-entity" /> 지식 엔티티</span>
          <span className="muted">· 노드 {filteredNodes.length} · 간선 {filteredEdges.length} (클릭 이동)</span>
        </div>
      </div>
    </div>
  );
}
