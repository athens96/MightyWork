import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { tasksApi, triageApi } from "../../api";
import { PlusIcon } from "../../components/icons";
import { RefreshButton } from "../../components/RefreshButton";
import { can as canDo } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import type { IntakeConfig, Priority, Task } from "../../types";
import { useCurrentProject } from "../projects/ProjectLayout";
import { PRIORITY_LABEL, PRIORITY_META } from "./tones";

/** Linear Triage / Plane Intake 스타일 신규 요청 분류 대기열 */
export function TriagePage() {
  const project = useCurrentProject();
  const canCreate = canDo(project, "create");
  const canEdit = canDo(project, "edit");
  const isAdmin = canDo(project, "admin");

  const [queue, setQueue] = useState<Task[]>([]);
  const [boardTasks, setBoardTasks] = useState<Task[]>([]);
  const [intake, setIntake] = useState<IntakeConfig | null>(null);
  const [includeDeclined, setIncludeDeclined] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dupTarget, setDupTarget] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [q, bt] = await Promise.all([
      triageApi.list(project.id, includeDeclined),
      tasksApi.list(project.id),
    ]);
    setQueue(q);
    setBoardTasks(bt);
    if (isAdmin) triageApi.getIntake(project.id).then(setIntake, () => {});
  }, [project.id, includeDeclined, isAdmin]);

  useEffect(() => {
    reload();
  }, [reload]);

  const { refreshing, lastUpdated, refresh } = useAutoRefresh(reload, {
    intervalMs: 30_000,
    shortcutKey: true,
  });

  const submitIntake = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await triageApi.create(project.id, { title: title.trim(), description: desc.trim(), priority });
    setTitle("");
    setDesc("");
    setNotice("트리아지 대기열에 접수했습니다.");
    reload();
  };

  const decide = async (
    task: Task,
    action: "accept" | "duplicate" | "snooze" | "decline",
    extra: { target_stage?: Task["stage"]; duplicate_of_id?: string } = {},
  ) => {
    setNotice(null);
    await triageApi.decide(project.id, task.id, { action, ...extra });
    const key = `${project.key}-${task.number}`;
    const msg =
      action === "accept"
        ? `${key} 항목을 보드로 수락했습니다.`
        : action === "duplicate"
          ? `${key} 항목을 중복으로 병합 처리했습니다.`
          : action === "snooze"
            ? `${key} 항목을 3일간 보류했습니다.`
            : `${key} 항목을 거절했습니다.`;
    setNotice(msg);
    reload();
  };

  const toggleIntake = async (enabled: boolean, rotate = false) => {
    const saved = await triageApi.saveIntake(project.id, { enabled, rotate_token: rotate });
    setIntake(saved);
    setNotice(enabled ? "외부 버그 제보 인테이크 주소를 활성화했습니다." : "외부 인테이크 접수를 비활성화했습니다.");
  };

  const pendingCount = queue.filter((t) => t.triage_status === "pending").length;
  const snoozedCount = queue.filter((t) => t.triage_status === "snoozed").length;

  return (
    <div className="cycles-page">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>
            트리아지 / 인테이크함{" "}
            <span className="pill tone-wait" style={{ marginLeft: 6 }}>
              대기 {pendingCount}
            </span>
            {snoozedCount > 0 && (
              <span className="pill tone-stop" style={{ marginLeft: 4 }}>
                보류 {snoozedCount}
              </span>
            )}
          </h2>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
            신규 제보·요청을 백로그에 바로 섞지 않고 수락 · 중복 병합 · 보류 · 거절로 빠르게 분류합니다.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <RefreshButton refreshing={refreshing} lastUpdated={lastUpdated} onClick={refresh} shortcut />
          <label className="kind-toggle">
            <input type="checkbox" checked={includeDeclined} onChange={(e) => setIncludeDeclined(e.target.checked)} /> 거절됨 포함
          </label>
          <Link to={`/projects/${project.id}/tasks`} className="btn btn-sm btn-ghost">
            ← 보드로 돌아가기
          </Link>
        </div>
      </div>

      {notice && (
        <div className="card" style={{ padding: "8px 12px", marginBottom: 12, borderColor: "var(--done)" }}>
          {notice}
        </div>
      )}

      {canCreate && (
        <form className="card cycle-form" onSubmit={submitIntake}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              style={{ flex: 2, minWidth: 220 }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="트리아지 대기열에 접수할 버그·요청 제목"
              required
            />
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="우선순위">
              {(["urgent", "high", "medium", "low"] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={!title.trim()}>
              <PlusIcon size={11} /> 접수
            </button>
          </div>
          <input
            style={{ width: "100%", marginTop: 8 }}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="간단한 배경·재현 경로 (선택)"
          />
        </form>
      )}

      {queue.length === 0 ? (
        <div className="card empty">트리아지 대기 중인 요청이 없습니다. 깔끔합니다!</div>
      ) : (
        <div className="cycle-list">
          {queue.map((t) => {
            const prio = PRIORITY_META[t.priority];
            const dupId = dupTarget[t.id] ?? "";
            return (
              <article key={t.id} className="card cycle-card">
                <div className="cycle-card-head">
                  <div>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <span className="key-badge">
                        {project.key}-{t.number}
                      </span>
                      <span className={`pill ${t.triage_status === "pending" ? "tone-wait" : "tone-stop"}`}>
                        {t.triage_status === "pending"
                          ? "검토 대기"
                          : t.triage_status === "snoozed"
                            ? `보류 (~${t.triage_snooze_until ?? ""})`
                            : "거절됨"}
                      </span>
                      {prio && <span className={`pill ${prio.tone}`}>{prio.label}</span>}
                      <strong>{t.title}</strong>
                    </div>
                    {t.description && (
                      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5, whiteSpace: "pre-wrap" }}>
                        {t.description}
                      </p>
                    )}
                    <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                      {t.triage_source && `출처: ${t.triage_source} · `}
                      {timeAgo(t.created_at)}
                    </div>
                  </div>
                </div>

                {canEdit && t.triage_status !== "declined" && (
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                    <button className="btn btn-sm btn-primary" onClick={() => decide(t, "accept", { target_stage: "backlog" })}>
                      수락 (백로그)
                    </button>
                    <button className="btn btn-sm" onClick={() => decide(t, "accept", { target_stage: "todo" })}>
                      수락 (할 일)
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => decide(t, "snooze")}>
                      보류 (3일)
                    </button>
                    <button className="btn btn-sm btn-ghost btn-danger" onClick={() => decide(t, "decline")}>
                      거절
                    </button>
                    <span className="spacer" />
                    {boardTasks.length > 0 && (
                      <div className="row" style={{ gap: 4 }}>
                        <select
                          className="filter-select"
                          value={dupId}
                          onChange={(e) => setDupTarget((prev) => ({ ...prev, [t.id]: e.target.value }))}
                          aria-label="중복 대상 일감"
                        >
                          <option value="">중복 원본 선택…</option>
                          {boardTasks.map((bt) => (
                            <option key={bt.id} value={bt.id}>
                              {project.key}-{bt.number} {bt.title.slice(0, 32)}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn btn-sm"
                          disabled={!dupId}
                          onClick={() => decide(t, "duplicate", { duplicate_of_id: dupId })}
                        >
                          중복 병합
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {isAdmin && (
        <section className="card mcp-connect" style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>외부 버그 제보 / 요청 접수 웹훅</h3>
            <div className="row" style={{ gap: 6 }}>
              {intake?.enabled ? (
                <>
                  <button className="btn btn-sm" onClick={() => toggleIntake(true, true)}>
                    토큰 재발급
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => toggleIntake(false)}>
                    비활성화
                  </button>
                </>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={() => toggleIntake(true)}>
                  외부 접수 활성화
                </button>
              )}
            </div>
          </div>
          <p className="muted mcp-help">
            활성화하면 외부 폼·고객센터·모니터링 도구에서 인증 없이 아래 엔드포인트로 POST 요청을 보내 트리아지 대기열로 접수할 수 있습니다.
          </p>
          {intake?.enabled && (
            <div className="copy-row">
              <code className="mono">{intake.intake_url}</code>
              <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(intake.intake_url)}>
                URL 복사
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
