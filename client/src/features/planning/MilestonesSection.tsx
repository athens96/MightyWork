import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { milestonesApi } from "../../api";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { RefreshButton } from "../../components/RefreshButton";
import { can as canDo } from "../../lib/permissions";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import type { Milestone, MilestoneStatus, Project } from "../../types";

const STATUS_META: Record<MilestoneStatus, { label: string; tone: string }> = {
  active: { label: "진행 중", tone: "tone-run" },
  planned: { label: "예정", tone: "tone-wait" },
  completed: { label: "완료", tone: "tone-done" },
};

const DAY_MS = 86_400_000;
function toDayMs(iso: string): number {
  return Date.parse(iso.slice(0, 10) + "T00:00:00Z");
}

/** 마일스톤(릴리즈/에픽) 그룹핑 + 목표일 기반 진행률 로드맵 타임라인 뷰 */
export function MilestonesSection({ project }: { project: Project }) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [targetDate, setTargetDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [status, setStatus] = useState<MilestoneStatus>("active");

  const canCreate = canDo(project, "create");
  const canEdit = canDo(project, "edit");
  const canDelete = canDo(project, "delete");

  const reload = useCallback(
    async (showLoader = false) => {
      if (showLoader) setLoading(true);
      try {
        setMilestones(await milestonesApi.list(project.id));
      } finally {
        if (showLoader) setLoading(false);
      }
    },
    [project.id],
  );

  useEffect(() => {
    void reload(true);
  }, [reload]);

  const { refreshing, lastUpdated, refresh } = useAutoRefresh(() => reload(false), {
    intervalMs: 30_000,
    shortcutKey: true,
  });

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await milestonesApi.create(project.id, {
      name: name.trim(),
      description: description.trim(),
      start_date: startDate || null,
      target_date: targetDate || null,
      status,
    });
    setName("");
    setDescription("");
    setShowCreate(false);
    reload();
  };

  const changeStatus = async (m: Milestone, next: MilestoneStatus) => {
    await milestonesApi.update(project.id, m.id, { status: next });
    reload();
  };

  const remove = async (m: Milestone) => {
    if (!confirm(`마일스톤 '${m.name}' 을 삭제할까요? 연결된 일감은 삭제되지 않고 마일스톤 배정만 해제됩니다.`)) return;
    await milestonesApi.remove(project.id, m.id);
    reload();
  };

  // 로드맵 타임라인 날짜 범위 계산
  const roadmap = useMemo(() => {
    const withDates = milestones.filter((m) => m.start_date || m.target_date);
    if (withDates.length === 0) return null;
    const today = toDayMs(new Date().toISOString());
    const bounds = withDates.flatMap((m) => {
      const s = m.start_date ? toDayMs(m.start_date) : toDayMs(m.created_at);
      const e = m.target_date ? toDayMs(m.target_date) : s + 14 * DAY_MS;
      return [s, e];
    });
    const minMs = Math.min(...bounds, today) - 3 * DAY_MS;
    const maxMs = Math.max(...bounds, today + 7 * DAY_MS) + 3 * DAY_MS;
    const span = Math.max(DAY_MS, maxMs - minMs);
    const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - minMs) / span) * 100));
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
      left: r * 100,
      label: new Date(minMs + span * r).toISOString().slice(5, 10),
    }));
    return {
      minMs,
      maxMs,
      todayLeft: pct(today),
      ticks,
      rows: withDates.map((m) => {
        const s = m.start_date ? toDayMs(m.start_date) : toDayMs(m.created_at);
        const e = m.target_date ? toDayMs(m.target_date) : s + 14 * DAY_MS;
        const left = pct(Math.min(s, e));
        const right = pct(Math.max(s, e));
        return { milestone: m, left, width: Math.max(4, right - left) };
      }),
    };
  }, [milestones]);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>마일스톤 · 로드맵</h2>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
            릴리즈(예: v1.0)나 주요 에픽 단위로 일감을 묶고 목표일 기준 진척률을 한눈에 추적합니다.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <RefreshButton refreshing={refreshing} lastUpdated={lastUpdated} onClick={refresh} shortcut />
          {canCreate && (
            <button className="btn btn-primary" onClick={() => setShowCreate((s) => !s)}>
              <PlusIcon size={11} /> 새 마일스톤
            </button>
          )}
        </div>
      </div>

      {showCreate && (
        <form className="card cycle-form" onSubmit={submitCreate}>
          <div className="cycle-form-grid">
            <label>
              <span>마일스톤 이름</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: v1.0 정식 출시" required autoFocus />
            </label>
            <label>
              <span>상태</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as MilestoneStatus)}>
                <option value="planned">예정</option>
                <option value="active">진행 중</option>
                <option value="completed">완료</option>
              </select>
            </label>
            <label>
              <span>시작일</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label>
              <span>목표일</span>
              <input type="date" value={targetDate} min={startDate || undefined} onChange={(e) => setTargetDate(e.target.value)} />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <span>설명</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="이 마일스톤의 출시 범위와 목표" />
            </label>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
              취소
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              마일스톤 만들기
            </button>
          </div>
        </form>
      )}

      {roadmap && (
        <section className="card roadmap-card">
          <div className="roadmap-axis">
            <span className="muted" style={{ fontSize: 11.5 }}>
              로드맵 타임라인
            </span>
            <div className="roadmap-track-head">
              {roadmap.ticks.map((t, idx) => (
                <span key={idx} className="mono muted" style={{ left: `${t.left}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          <div className="roadmap-rows">
            {roadmap.rows.map(({ milestone: m, left, width }) => (
              <div key={m.id} className="roadmap-row">
                <div className="roadmap-label">
                  <Link to={`/projects/${project.id}/tasks?milestone=${m.id}`} className="index-title">
                    {m.name}
                  </Link>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {m.progress_pct}% ({m.done_tasks}/{m.total_tasks})
                  </span>
                </div>
                <div className="roadmap-lane">
                  <span className="roadmap-today" style={{ left: `${roadmap.todayLeft}%` }} title="오늘" />
                  <Link
                    to={`/projects/${project.id}/tasks?milestone=${m.id}`}
                    className={`roadmap-bar ${STATUS_META[m.status].tone}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${m.name}: ${m.start_date ?? ""} ~ ${m.target_date ?? ""} (${m.progress_pct}%)`}
                  >
                    <span className="roadmap-bar-fill" style={{ width: `${m.progress_pct}%` }} />
                    <span className="roadmap-bar-text">{m.name}</span>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {loading ? (
        <p className="muted">마일스톤 불러오는 중…</p>
      ) : milestones.length === 0 ? (
        <div className="card empty">
          등록된 마일스톤이 없습니다.
          {canCreate && " '새 마일스톤' 버튼으로 릴리즈 목표를 만들어 보세요."}
        </div>
      ) : (
        <div className="cycle-list">
          {milestones.map((m) => {
            const meta = STATUS_META[m.status];
            return (
              <article key={m.id} className={`card cycle-card ${m.status === "active" ? "is-active" : ""}`}>
                <div className="cycle-card-head">
                  <div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 15 }}>{m.name}</strong>
                      <span className={`pill ${meta.tone}`}>{meta.label}</span>
                      {(m.start_date || m.target_date) && (
                        <span className="mono muted" style={{ fontSize: 12 }}>
                          {m.start_date ?? "시작 미정"} → {m.target_date ?? "목표일 미정"}
                        </span>
                      )}
                    </div>
                    {m.description && (
                      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                        {m.description}
                      </p>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Link to={`/projects/${project.id}/tasks?milestone=${m.id}`} className="btn btn-sm btn-ghost">
                      일감 보기 ({m.total_tasks})
                    </Link>
                    {canEdit && (
                      <select
                        className="filter-select"
                        value={m.status}
                        onChange={(e) => changeStatus(m, e.target.value as MilestoneStatus)}
                        aria-label={`${m.name} 상태`}
                      >
                        <option value="planned">예정</option>
                        <option value="active">진행 중</option>
                        <option value="completed">완료</option>
                      </select>
                    )}
                    {canDelete && (
                      <button className="icon-btn danger" onClick={() => remove(m)} title="마일스톤 삭제">
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="cycle-metrics">
                  <div className="cycle-progress">
                    <div className="cycle-progress-bar">
                      <span style={{ width: `${m.progress_pct}%` }} />
                    </div>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {m.progress_pct}%
                    </span>
                  </div>
                  <div className="cycle-stats muted">
                    <span>
                      완료 <strong>{m.done_tasks}</strong> / {m.total_tasks}건
                    </span>
                    <span>
                      진행·리뷰 <strong>{m.in_progress_tasks}</strong>건
                    </span>
                    {m.total_points > 0 && (
                      <span>
                        포인트 <strong>{m.done_points}</strong> / {m.total_points}pt
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
