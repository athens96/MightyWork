import { useMemo } from "react";
import { Link } from "react-router-dom";
import { todayYmd } from "../../lib/time";
import type { Task, TaskUpdate } from "../../types";
import { STAGE_TONE } from "./tones";

const DAY_MS = 86_400_000;

function parseYmd(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmtYmd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(ymd: string, delta: number): string {
  return fmtYmd(parseYmd(ymd) + delta * DAY_MS);
}

interface Props {
  projectId: string;
  projectKey: string;
  tasks: Task[];
  canEdit: boolean;
  onPatchTask: (taskId: string, body: TaskUpdate) => Promise<void>;
}

/** 타임라인(간트) 뷰 — start_date ~ due_date 일정 막대 + 빠른 날짜 조정 */
export function TaskTimelineView({ projectId, projectKey, tasks, canEdit, onPatchTask }: Props) {
  const today = todayYmd();
  const todayMs = parseYmd(today);

  const scheduled = useMemo(() => tasks.filter((t) => t.start_date || t.due_date), [tasks]);
  const unscheduled = useMemo(() => tasks.filter((t) => !t.start_date && !t.due_date), [tasks]);

  const { rangeStart, totalDays, ticks } = useMemo(() => {
    let minMs = todayMs - 5 * DAY_MS;
    let maxMs = todayMs + 25 * DAY_MS;
    for (const t of scheduled) {
      const s = parseYmd(t.start_date ?? t.due_date!);
      const e = parseYmd(t.due_date ?? t.start_date!);
      if (s - 2 * DAY_MS < minMs) minMs = s - 2 * DAY_MS;
      if (e + 3 * DAY_MS > maxMs) maxMs = e + 3 * DAY_MS;
    }
    const days = Math.max(14, Math.min(180, Math.round((maxMs - minMs) / DAY_MS) + 1));
    const step = days > 60 ? 7 : days > 30 ? 4 : 2;
    const list: { offset: number; label: string }[] = [];
    for (let i = 0; i < days; i += step) {
      const d = new Date(minMs + i * DAY_MS);
      list.push({ offset: i, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` });
    }
    return { rangeStart: minMs, totalDays: days, ticks: list };
  }, [scheduled, todayMs]);

  const todayPct = ((todayMs - rangeStart) / DAY_MS / totalDays) * 100;

  const shiftTask = (t: Task, deltaDays: number) => {
    const start = t.start_date ?? t.due_date ?? today;
    const due = t.due_date ?? t.start_date ?? today;
    onPatchTask(t.id, { start_date: addDays(start, deltaDays), due_date: addDays(due, deltaDays) });
  };

  return (
    <div className="timeline-wrap">
      <div className="card gantt-card">
        <div className="gantt-head">
          <div className="gantt-label-col">일감 ({scheduled.length})</div>
          <div className="gantt-track-col gantt-scale">
            {ticks.map((tk) => (
              <span key={tk.offset} style={{ left: `${(tk.offset / totalDays) * 100}%` }}>
                {tk.label}
              </span>
            ))}
          </div>
        </div>

        {scheduled.length === 0 ? (
          <div className="empty">일정(시작일·종료일)이 설정된 일감이 없습니다. 아래 미배정 일감에서 '일정 지정'을 눌러보세요.</div>
        ) : (
          <div className="gantt-rows">
            {scheduled.map((t) => {
              const sYmd = t.start_date ?? t.due_date!;
              const eYmd = t.due_date ?? t.start_date!;
              const sIdx = Math.max(0, (parseYmd(sYmd) - rangeStart) / DAY_MS);
              const span = Math.max(1, (parseYmd(eYmd) - parseYmd(sYmd)) / DAY_MS + 1);
              const leftPct = (sIdx / totalDays) * 100;
              const widthPct = Math.min(100 - leftPct, Math.max(2.5, (span / totalDays) * 100));
              return (
                <div key={t.id} className="gantt-row">
                  <div className="gantt-label-col">
                    <Link to={`/projects/${projectId}/tasks/${t.id}`} className="gantt-title">
                      <span className="mono muted">{projectKey}-{t.number}</span> {t.title}
                    </Link>
                    {canEdit && (
                      <span className="gantt-nudge">
                        <button type="button" className="btn btn-sm btn-ghost" title="하루 앞당기기" onClick={() => shiftTask(t, -1)}>
                          ‹
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" title="하루 미루기" onClick={() => shiftTask(t, 1)}>
                          ›
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="gantt-track-col">
                    {todayPct >= 0 && todayPct <= 100 && <span className="gantt-today" style={{ left: `${todayPct}%` }} />}
                    <Link
                      to={`/projects/${projectId}/tasks/${t.id}`}
                      className={`gantt-bar ${STAGE_TONE[t.stage]}`}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`${projectKey}-${t.number} ${t.title} (${sYmd} ~ ${eYmd})`}
                    >
                      <span>{sYmd.slice(5)}~{eYmd.slice(5)}</span>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {unscheduled.length > 0 && (
        <div className="card unscheduled-card">
          <div className="group-head">일정 미지정 일감 ({unscheduled.length})</div>
          <div className="conn-group">
            {unscheduled.map((t) => (
              <span key={t.id} className={`conn-chip task ${STAGE_TONE[t.stage]}`}>
                <Link to={`/projects/${projectId}/tasks/${t.id}`}>
                  {projectKey}-{t.number} {t.title}
                </Link>
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ padding: "0 4px", height: 18, fontSize: 11 }}
                    onClick={() => onPatchTask(t.id, { start_date: today, due_date: addDays(today, 3) })}
                  >
                    +일정
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
