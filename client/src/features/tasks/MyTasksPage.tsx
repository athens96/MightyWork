import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { pipelineApi, tasksApi } from "../../api";
import { can } from "../../lib/permissions";
import { dueState, formatDate } from "../../lib/time";
import type { MyTask, PipelineStage, PipelineStageInfo } from "../../types";
import { useProjects } from "../projects/ProjectsContext";
import { PRIORITY_LABEL, PRIORITY_META, STAGE_TONE } from "./tones";

const DUE_TONE = { overdue: "tone-err", soon: "tone-wait", ok: "" } as const;

/** 전 프로젝트 통합 '내 일감(My Issues)' 화면 */
export function MyTasksPage() {
  const { projects } = useProjects();
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [stages, setStages] = useState<PipelineStageInfo[]>([]);
  const [scope, setScope] = useState<"assigned" | "created" | "all">("assigned");
  const [dueSoon, setDueSoon] = useState(false);
  const [includeDone, setIncludeDone] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([pipelineApi.get(), tasksApi.my({ scope, due_soon: dueSoon, include_done: includeDone })])
      .then(([p, t]) => {
        setStages(p);
        setTasks(t);
      })
      .finally(() => setLoading(false));
  }, [scope, dueSoon, includeDone]);

  useEffect(() => {
    reload();
  }, [reload]);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const visible = useMemo(() => (projectFilter ? tasks.filter((t) => t.project_id === projectFilter) : tasks), [tasks, projectFilter]);

  const urgentDue = visible.filter((t) => {
    const d = dueState(t.due_date, t.stage === "done");
    return d === "overdue" || d === "soon";
  }).length;

  const moveStage = async (t: MyTask, stage: PipelineStage) => {
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, stage } : x)));
    try {
      await tasksApi.update(t.project_id, t.id, { stage });
    } catch {
      reload();
    }
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h1 className="dash-title">내 일감</h1>
          <p className="dash-sub">
            모든 프로젝트의 내 작업을 한 곳에서 관리 · {visible.length}건
          </p>
        </div>
      </header>

      <section className="tiles">
        <div className="tile fill-run">
          <span className="tile-num">{visible.filter((t) => t.stage === "in_progress").length}</span>
          <span className="tile-label">진행 중</span>
        </div>
        <div className="tile fill-wait">
          <span className="tile-num">{urgentDue}</span>
          <span className="tile-label">마감 임박 · 지남</span>
        </div>
        <div className="tile">
          <span className="tile-num">{visible.filter((t) => t.stage !== "done").length}</span>
          <span className="tile-label">미완료 전체</span>
        </div>
        <div className="tile text-done">
          <span className="tile-num">{visible.filter((t) => t.stage === "done").length}</span>
          <span className="tile-label">완료</span>
        </div>
      </section>

      <div className="filter-bar">
        <div className="segment">
          {([
            ["assigned", "내게 배정됨"],
            ["created", "내가 만듦"],
            ["all", "전체"],
          ] as const).map(([s, label]) => (
            <button key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>
              {label}
            </button>
          ))}
        </div>
        <select className="filter-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="프로젝트 필터">
          <option value="">모든 프로젝트</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} · {p.name}
            </option>
          ))}
        </select>
        <label className="kind-toggle">
          <input type="checkbox" checked={dueSoon} onChange={(e) => setDueSoon(e.target.checked)} /> 마감 임박·지남만
        </label>
        <label className="kind-toggle">
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} /> 완료 포함
        </label>
      </div>

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : visible.length === 0 ? (
        <div className="card empty">표시할 일감이 없습니다.</div>
      ) : (
        <div className="card list-view-card">
          <table className="index-table">
            <thead>
              <tr>
                <th>키</th>
                <th>프로젝트</th>
                <th>제목</th>
                <th>단계</th>
                <th>우선순위</th>
                <th>마감일</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const proj = projectById.get(t.project_id);
                const canEdit = proj ? can(proj, "edit") : false;
                const due = dueState(t.due_date, t.stage === "done");
                const prio = PRIORITY_META[t.priority];
                return (
                  <tr key={t.id}>
                    <td className="nowrap">
                      <Link to={`/projects/${t.project_id}/tasks/${t.id}`} className={`key-badge ${STAGE_TONE[t.stage]}`}>
                        {t.project_key}-{t.number}
                      </Link>
                    </td>
                    <td className="nowrap muted">{t.project_name}</td>
                    <td>
                      <Link to={`/projects/${t.project_id}/tasks/${t.id}`} className="index-title">
                        {t.title}
                      </Link>
                      {t.tags.length > 0 && (
                        <span className="list-tags">
                          {t.tags.map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="nowrap">
                      {canEdit ? (
                        <select
                          className={`inline-stage-select ${STAGE_TONE[t.stage]}`}
                          value={t.stage}
                          onChange={(e) => moveStage(t, e.target.value as PipelineStage)}
                        >
                          {stages.map((s) => (
                            <option key={s.key} value={s.key}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`pill ${STAGE_TONE[t.stage]}`}>
                          {stages.find((s) => s.key === t.stage)?.label ?? t.stage}
                        </span>
                      )}
                    </td>
                    <td className="nowrap">
                      {prio ? <span className={`pill ${prio.tone}`}>{prio.label}</span> : <span className="muted">{PRIORITY_LABEL[t.priority]}</span>}
                    </td>
                    <td className="nowrap">
                      {t.due_date ? <span className={`badge ${due ? DUE_TONE[due] : ""}`}>{formatDate(t.due_date)}</span> : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
