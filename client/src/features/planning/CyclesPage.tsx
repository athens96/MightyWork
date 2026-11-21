import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cyclesApi } from "../../api";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { can as canDo } from "../../lib/permissions";
import type { Cycle, CycleStatus } from "../../types";
import { useCurrentProject } from "../projects/ProjectLayout";
import { MilestonesSection } from "./MilestonesSection";

const STATUS_META: Record<CycleStatus, { label: string; tone: string }> = {
  active: { label: "진행 중", tone: "tone-run" },
  upcoming: { label: "예정", tone: "tone-wait" },
  completed: { label: "완료", tone: "tone-done" },
};

function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 경량 SVG 번다운 차트 (이상선 점선 + 실제 남은 범위 실선/영역) */
function BurndownChart({ cycle }: { cycle: Cycle }) {
  const pts = cycle.burndown;
  if (pts.length < 2) return null;
  const W = 440;
  const H = 150;
  const padL = 30;
  const padR = 14;
  const padT = 12;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxVal = Math.max(1, ...pts.map((p) => Math.max(p.ideal, p.remaining ?? 0)));
  const xAt = (i: number) => padL + (i / (pts.length - 1)) * plotW;
  const yAt = (v: number) => padT + plotH - (v / maxVal) * plotH;

  const idealPath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.ideal).toFixed(1)}`).join(" ");
  const actualPts = pts
    .map((p, i) => (p.remaining === null ? null : { i, v: p.remaining }))
    .filter((x): x is { i: number; v: number } => x !== null);
  const actualPath = actualPts.map((p, idx) => `${idx === 0 ? "M" : "L"}${xAt(p.i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(" ");
  const areaPath =
    actualPts.length > 0
      ? `${actualPath} L${xAt(actualPts[actualPts.length - 1].i).toFixed(1)},${(padT + plotH).toFixed(1)} L${xAt(actualPts[0].i).toFixed(1)},${(padT + plotH).toFixed(1)} Z`
      : "";
  const unit = cycle.total_points > 0 ? "pt" : "건";

  return (
    <div className="burndown-wrap">
      <div className="burndown-head">
        <span className="muted">번다운 ({unit})</span>
        <span className="burndown-legend">
          <span>
            <i className="leg-ideal" /> 이상 추이
          </span>
          <span>
            <i className="leg-actual" /> 남은 작업
          </span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="burndown-svg" role="img" aria-label={`${cycle.name} 번다운 차트`}>
        {[0, 0.5, 1].map((r) => {
          const y = padT + plotH * (1 - r);
          const val = Math.round(maxVal * r);
          return (
            <g key={r}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} className="bd-grid" />
              <text x={padL - 5} y={y + 3} textAnchor="end" className="bd-axis">
                {val}
              </text>
            </g>
          );
        })}
        <path d={idealPath} className="bd-ideal" fill="none" />
        {areaPath && <path d={areaPath} className="bd-area" />}
        {actualPath && <path d={actualPath} className="bd-actual" fill="none" />}
        {actualPts.length > 0 && (
          <circle
            cx={xAt(actualPts[actualPts.length - 1].i)}
            cy={yAt(actualPts[actualPts.length - 1].v)}
            r={3.5}
            className="bd-dot"
          />
        )}
        <text x={padL} y={H - 6} className="bd-axis">
          {pts[0].day.slice(5)}
        </text>
        <text x={W - padR} y={H - 6} textAnchor="end" className="bd-axis">
          {pts[pts.length - 1].day.slice(5)}
        </text>
      </svg>
    </div>
  );
}

/** 프로젝트 계획 화면: 사이클(스프린트) + 마일스톤(릴리즈/로드맵) */
export function CyclesPage() {
  const project = useCurrentProject();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") === "milestones" ? "milestones" : "cycles";
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [startDate, setStartDate] = useState(() => isoOffset(0));
  const [endDate, setEndDate] = useState(() => isoOffset(13));
  const [targetPoints, setTargetPoints] = useState("");
  const [status, setStatus] = useState<CycleStatus>("active");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canCreate = canDo(project, "create");
  const canEdit = canDo(project, "edit");
  const canDelete = canDo(project, "delete");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setCycles(await cyclesApi.list(project.id));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const activeCycles = useMemo(() => cycles.filter((c) => c.status === "active"), [cycles]);
  const completedCycles = useMemo(() => cycles.filter((c) => c.status === "completed"), [cycles]);
  const avgVelocity = useMemo(() => {
    if (completedCycles.length === 0) return 0;
    const sum = completedCycles.reduce((acc, c) => acc + (c.done_points || c.done_tasks), 0);
    return Math.round((sum / completedCycles.length) * 10) / 10;
  }, [completedCycles]);
  const velocityUnit = useMemo(() => (completedCycles.some((c) => c.done_points > 0) ? "pt" : "건"), [completedCycles]);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await cyclesApi.create(project.id, {
      name: name.trim(),
      goal: goal.trim(),
      start_date: startDate,
      end_date: endDate,
      target_points: targetPoints.trim() ? Number(targetPoints) : null,
      status,
    });
    setName("");
    setGoal("");
    setTargetPoints("");
    setShowCreate(false);
    reload();
  };

  const completeCycle = async (c: Cycle) => {
    const remaining = c.total_tasks - c.done_tasks;
    const msg =
      remaining > 0
        ? `'${c.name}' 사이클을 종료하고 미완료 일감 ${remaining}건을 다음 사이클로 자동 이월할까요?`
        : `'${c.name}' 사이클을 완료 처리할까요?`;
    if (!confirm(msg)) return;
    setBusyId(c.id);
    setNotice(null);
    try {
      const res = await cyclesApi.complete(project.id, c.id, { rollover: remaining > 0 });
      setNotice(
        res.rolled_over_count > 0 && res.next_cycle
          ? `'${c.name}' 종료 완료 — 미완료 ${res.rolled_over_count}건을 '${res.next_cycle.name}'으로 이월했습니다.`
          : `'${c.name}' 사이클을 완료했습니다.`,
      );
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const startCycle = async (c: Cycle) => {
    setBusyId(c.id);
    try {
      await cyclesApi.update(project.id, c.id, { status: "active" });
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const removeCycle = async (c: Cycle) => {
    if (!confirm(`'${c.name}' 사이클을 삭제할까요? 연결된 일감은 삭제되지 않고 사이클 배정만 해제됩니다.`)) return;
    await cyclesApi.remove(project.id, c.id);
    reload();
  };

  const primaryActive = activeCycles[0];

  return (
    <div className="cycles-page">
      <div className="kb-bar" style={{ marginBottom: 12 }}>
        <div className="segment">
          <button aria-pressed={activeTab === "cycles"} onClick={() => setSearchParams({}, { replace: true })}>
            사이클 · 스프린트
          </button>
          <button aria-pressed={activeTab === "milestones"} onClick={() => setSearchParams({ tab: "milestones" }, { replace: true })}>
            마일스톤 · 로드맵
          </button>
        </div>
      </div>

      {activeTab === "milestones" ? (
        <MilestonesSection project={project} />
      ) : (
        <>
      <section className="tiles">
        <div className="tile fill-run">
          <span className="tile-num">{activeCycles.length}</span>
          <span className="tile-label">진행 중 사이클</span>
        </div>
        <div className="tile fill-wait">
          <span className="tile-num">{primaryActive ? `${primaryActive.completion_pct}%` : "—"}</span>
          <span className="tile-label">현재 사이클 진척률</span>
        </div>
        <div className="tile text-done">
          <span className="tile-num">
            {avgVelocity}
            <small style={{ fontSize: 13, marginLeft: 2 }}>{velocityUnit}</small>
          </span>
          <span className="tile-label">평균 속도 (Velocity)</span>
        </div>
        <div className="tile">
          <span className="tile-num">{completedCycles.length}</span>
          <span className="tile-label">완료된 사이클</span>
        </div>
      </section>

      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>사이클 · 스프린트</h2>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
            주간·격주 실행 단위로 일감을 묶고 번다운과 속도를 추적합니다.
          </p>
        </div>
        {canCreate && (
          <button className="btn btn-primary" onClick={() => setShowCreate((s) => !s)}>
            <PlusIcon size={11} /> 새 사이클
          </button>
        )}
      </div>

      {notice && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 12, borderColor: "var(--done)" }}>
          {notice}
        </div>
      )}

      {showCreate && (
        <form className="card cycle-form" onSubmit={submitCreate}>
          <div className="cycle-form-grid">
            <label>
              <span>이름</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`예: Cycle ${cycles.length + 1}`} required autoFocus />
            </label>
            <label>
              <span>상태</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as CycleStatus)}>
                <option value="active">진행 중</option>
                <option value="upcoming">예정</option>
              </select>
            </label>
            <label>
              <span>시작일</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </label>
            <label>
              <span>종료일</span>
              <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
            </label>
            <label>
              <span>목표 포인트 (pt)</span>
              <input type="number" min={0} max={10000} value={targetPoints} onChange={(e) => setTargetPoints(e.target.value)} placeholder="선택" />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <span>목표 요약</span>
              <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="이번 사이클에서 달성할 핵심 목표" />
            </label>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
              취소
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              사이클 만들기
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="muted">사이클 불러오는 중…</p>
      ) : cycles.length === 0 ? (
        <div className="card empty">
          아직 생성된 사이클이 없습니다.
          {canCreate && " 오른쪽 위 '새 사이클' 버튼으로 첫 실행 주기를 만들어 보세요."}
        </div>
      ) : (
        <div className="cycle-list">
          {cycles.map((c) => {
            const meta = STATUS_META[c.status];
            return (
              <article key={c.id} className={`card cycle-card ${c.status === "active" ? "is-active" : ""}`}>
                <div className="cycle-card-head">
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <strong style={{ fontSize: 15 }}>{c.name}</strong>
                      <span className={`pill ${meta.tone}`}>{meta.label}</span>
                      <span className="mono muted" style={{ fontSize: 12 }}>
                        {c.start_date} ~ {c.end_date}
                      </span>
                    </div>
                    {c.goal && (
                      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                        {c.goal}
                      </p>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Link to={`/projects/${project.id}/tasks?cycle=${c.id}`} className="btn btn-sm btn-ghost">
                      보드에서 보기 ({c.total_tasks})
                    </Link>
                    {canEdit && c.status === "upcoming" && (
                      <button className="btn btn-sm btn-ghost" disabled={busyId === c.id} onClick={() => startCycle(c)}>
                        시작
                      </button>
                    )}
                    {canEdit && c.status === "active" && (
                      <button className="btn btn-sm btn-primary" disabled={busyId === c.id} onClick={() => completeCycle(c)}>
                        완료 · 이월
                      </button>
                    )}
                    {canDelete && (
                      <button className="icon-btn danger" onClick={() => removeCycle(c)} title="사이클 삭제">
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="cycle-metrics">
                  <div className="cycle-progress">
                    <div className="cycle-progress-bar">
                      <span style={{ width: `${c.completion_pct}%` }} />
                    </div>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {c.completion_pct}%
                    </span>
                  </div>
                  <div className="cycle-stats muted">
                    <span>
                      일감 <strong>{c.done_tasks}</strong> / {c.total_tasks}
                    </span>
                    <span>
                      포인트 <strong>{c.done_points}</strong> / {c.total_points}pt
                      {c.target_points ? ` (목표 ${c.target_points}pt)` : ""}
                    </span>
                  </div>
                </div>

                {(c.status === "active" || c.total_tasks > 0) && <BurndownChart cycle={c} />}
              </article>
            );
          })}
        </div>
      )}

      {completedCycles.length > 0 && (
        <section className="card" style={{ padding: 14, marginTop: 14 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 13.5 }}>최근 완료 사이클 속도 (Velocity)</h3>
          <div className="velocity-bars">
            {completedCycles
              .slice(0, 6)
              .reverse()
              .map((c) => {
                const val = c.done_points || c.done_tasks;
                const max = Math.max(1, ...completedCycles.map((x) => x.done_points || x.done_tasks));
                return (
                  <div key={c.id} className="velocity-col">
                    <span className="mono" style={{ fontSize: 11 }}>
                      {val}
                      {velocityUnit}
                    </span>
                    <div className="velocity-track">
                      <span style={{ height: `${Math.max(8, Math.round((val / max) * 100))}%` }} />
                    </div>
                    <span className="muted velocity-name" title={c.name}>
                      {c.name}
                    </span>
                  </div>
                );
              })}
          </div>
        </section>
      )}
        </>
      )}
    </div>
  );
}
