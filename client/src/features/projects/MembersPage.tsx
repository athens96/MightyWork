import { useCallback, useEffect, useState, type FormEvent } from "react";
import { githubApi, membersApi, pipelineApi, projectsApi, templatesApi, webhooksApi } from "../../api";
import { ApiError } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { Avatar } from "../../components/Avatar";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { can, normalize, PERMISSION_HINT, PERMISSION_LABEL, PERMISSIONS, PRESETS } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import type {
  AuditLog,
  GitHubConfig,
  Member,
  Permission,
  PipelineStageInfo,
  Priority,
  ProjectWebhook,
  TaskTemplate,
  WebhookDelivery,
  WebhookPreset,
} from "../../types";
import { useCurrentProject } from "./ProjectLayout";
import { useProjects } from "./ProjectsContext";

const WEBHOOK_EVENT_LABELS: [string, string][] = [
  ["task.created", "일감 생성"],
  ["task.stage_changed", "단계 이동"],
  ["comment.created", "덧글"],
  ["mention", "@멘션"],
  ["due_soon", "마감 임박"],
];

const INVITE_STATUS_MSG: Record<string, string> = {
  sent: "초대 메일을 발송했습니다.",
  skipped_unconfigured: "멤버가 추가되었습니다 (SMTP 미설정으로 메일 발송은 건너뛰었습니다).",
  failed: "멤버는 추가되었지만 초대 메일 발송에 실패했습니다.",
};

/** 프로젝트 멤버·권한 관리 + 초대 메일 재발송 + 소유권 이전 + 감사 로그(관리자 전용) */
export function MembersPage() {
  const project = useCurrentProject();
  const { reload: reloadProjects } = useProjects();
  const { user: me } = useAuth();
  const isAdmin = can(project, "admin");
  const [members, setMembers] = useState<Member[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [logFilter, setLogFilter] = useState("");
  const [gh, setGh] = useState<GitHubConfig | null>(null);
  const [ghRepo, setGhRepo] = useState("");
  const [ghAuto, setGhAuto] = useState(true);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [tplName, setTplName] = useState("");
  const [tplPrefix, setTplPrefix] = useState("");
  const [tplPriority, setTplPriority] = useState<Priority>("medium");
  const [tplTags, setTplTags] = useState("");
  const [tplDesc, setTplDesc] = useState("");
  const [tplCheck, setTplCheck] = useState("");
  const [pipeline, setPipeline] = useState<PipelineStageInfo[]>([]);
  const [webhooks, setWebhooks] = useState<ProjectWebhook[]>([]);
  const [whName, setWhName] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whPreset, setWhPreset] = useState<WebhookPreset>("slack");
  const [whEvents, setWhEvents] = useState<string[]>(["task.created", "task.stage_changed", "comment.created", "mention", "due_soon"]);
  const [whLogsId, setWhLogsId] = useState<string | null>(null);
  const [whLogs, setWhLogs] = useState<WebhookDelivery[]>([]);
  const [tab, setTab] = useState<"members" | "integrations" | "audit">("members");
  const [email, setEmail] = useState("");
  const [preset, setPreset] = useState(1);
  const [sendInvite, setSendInvite] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => membersApi.list(project.id).then(setMembers), [project.id]);
  const reloadLogs = useCallback(() => {
    if (isAdmin) projectsApi.auditLogs(project.id, logFilter || undefined).then(setLogs, () => {});
  }, [project.id, isAdmin, logFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (tab === "audit") reloadLogs();
    if (tab === "integrations") {
      githubApi.getConfig(project.id).then((cfg) => {
        setGh(cfg);
        setGhRepo(cfg.repo);
        setGhAuto(cfg.auto_transition);
      }, () => {});
      templatesApi.list(project.id).then(setTemplates, () => {});
      pipelineApi.forProject(project.id).then(setPipeline, () => {});
      if (isAdmin) webhooksApi.list(project.id).then(setWebhooks, () => {});
    }
  }, [tab, reloadLogs, project.id, isAdmin]);

  const addWebhook = async (e: FormEvent) => {
    e.preventDefault();
    if (!whName.trim() || !whUrl.trim()) return;
    setNotice(null);
    setError(null);
    try {
      const created = await webhooksApi.create(project.id, {
        name: whName.trim(),
        url: whUrl.trim(),
        preset: whPreset,
        events: whEvents,
      });
      setWebhooks((prev) => [...prev, created]);
      setWhName("");
      setWhUrl("");
      setNotice(
        created.generated_secret
          ? `웹훅 '${created.name}' 을 등록했습니다. 서명 Secret (1회 표시): ${created.generated_secret}`
          : `웹훅 '${created.name}' 을 등록했습니다.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? String(err.detail) : "웹훅 등록에 실패했습니다.");
    }
  };

  const toggleWebhook = async (h: ProjectWebhook) => {
    const updated = await webhooksApi.update(project.id, h.id, { enabled: !h.enabled });
    setWebhooks((prev) => prev.map((x) => (x.id === h.id ? updated : x)));
  };

  const sendTestWebhook = async (h: ProjectWebhook) => {
    setNotice(null);
    setError(null);
    const d = await webhooksApi.test(project.id, h.id);
    if (d.ok) setNotice(`'${h.name}' 테스트 발송 성공 (HTTP ${d.status_code ?? 200}, ${d.attempts}회 시도)`);
    else setError(`'${h.name}' 테스트 발송 실패: ${d.error || "응답 오류"}`);
    if (whLogsId === h.id) webhooksApi.deliveries(project.id, h.id).then(setWhLogs, () => {});
  };

  const openWebhookLogs = async (h: ProjectWebhook) => {
    if (whLogsId === h.id) {
      setWhLogsId(null);
      return;
    }
    setWhLogsId(h.id);
    setWhLogs(await webhooksApi.deliveries(project.id, h.id));
  };

  const removeWebhook = async (h: ProjectWebhook) => {
    if (!confirm(`웹훅 '${h.name}' 을 삭제할까요?`)) return;
    await webhooksApi.remove(project.id, h.id);
    setWebhooks((prev) => prev.filter((x) => x.id !== h.id));
    if (whLogsId === h.id) setWhLogsId(null);
  };

  const moveStageOrder = (idx: number, dir: -1 | 1) => {
    setPipeline((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  };

  const savePipeline = async (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setError(null);
    if (!pipeline.some((s) => !s.hidden)) {
      setError("최소 1개 이상의 파이프라인 단계는 표시되어야 합니다.");
      return;
    }
    try {
      const saved = await pipelineApi.save(project.id, pipeline);
      setPipeline(saved);
      setNotice("파이프라인 컬럼 및 WIP 제한을 저장했습니다.");
    } catch {
      setError("파이프라인 저장에 실패했습니다.");
    }
  };

  const resetPipelineDefaults = async () => {
    const defaults = await pipelineApi.get();
    setPipeline(defaults);
  };

  const addTemplate = async (e: FormEvent) => {
    e.preventDefault();
    if (!tplName.trim()) return;
    setNotice(null);
    setError(null);
    try {
      const created = await templatesApi.create(project.id, {
        name: tplName.trim(),
        title_prefix: tplPrefix,
        priority: tplPriority,
        tags: tplTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        description: tplDesc,
        checklist: tplCheck
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      setTemplates((prev) => [...prev, created]);
      setTplName("");
      setTplPrefix("");
      setTplTags("");
      setTplDesc("");
      setTplCheck("");
      setNotice(`일감 템플릿 '${created.name}' 을 추가했습니다.`);
    } catch {
      setError("템플릿 저장에 실패했습니다.");
    }
  };

  const removeTemplate = async (tpl: TaskTemplate) => {
    if (!confirm(`'${tpl.name}' 템플릿을 삭제할까요?`)) return;
    await templatesApi.remove(project.id, tpl.id);
    setTemplates((prev) => prev.filter((x) => x.id !== tpl.id));
  };

  const saveGitHub = async (e: FormEvent, rotate = false) => {
    e.preventDefault();
    setNotice(null);
    setError(null);
    try {
      const saved = await githubApi.saveConfig(project.id, { repo: ghRepo, auto_transition: ghAuto, rotate_secret: rotate });
      setGh(saved);
      setNotice(saved.generated_secret ? `저장되었습니다. Webhook Secret (1회 표시): ${saved.generated_secret}` : "GitHub 연동 설정을 저장했습니다.");
    } catch {
      setError("GitHub 연동 설정 저장에 실패했습니다.");
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const m = await membersApi.add(project.id, email.trim(), PRESETS[preset].permissions, sendInvite);
      setMembers((prev) => [...prev, m]);
      setEmail("");
      if (m.invite_status && INVITE_STATUS_MSG[m.invite_status]) setNotice(INVITE_STATUS_MSG[m.invite_status]);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "이미 멤버인 이메일입니다."
          : err instanceof ApiError && err.status === 422
            ? "이메일 형식을 확인하세요."
            : "추가하지 못했습니다.",
      );
    }
  };

  const resend = async (m: Member) => {
    setError(null);
    setNotice(null);
    try {
      const res = await membersApi.resendInvite(project.id, m.id);
      setNotice(INVITE_STATUS_MSG[res.invite_status ?? ""] ?? "초대 재발송을 처리했습니다.");
    } catch {
      setError("초대 메일 재발송에 실패했습니다.");
    }
  };

  const transferOwnership = async (m: Member) => {
    if (!m.user) return;
    if (!confirm(`'${m.user.name || m.email}' 님에게 프로젝트 소유권을 넘길까요?\n이전 후 내 계정은 관리자 멤버로 전환됩니다.`)) return;
    setError(null);
    setNotice(null);
    try {
      await projectsApi.transferOwnership(project.id, m.user.id);
      await reloadProjects();
      await reload();
      setNotice(`${m.user.name || m.email} 님에게 소유권이 이전되었습니다.`);
    } catch (err) {
      setError(err instanceof ApiError ? String(err.detail) : "소유권 이전에 실패했습니다.");
    }
  };

  const toggle = async (m: Member, perm: Permission) => {
    const next = m.permissions.includes(perm) ? m.permissions.filter((p) => p !== perm) : [...m.permissions, perm];
    const perms = perm === "admin" && m.permissions.includes("admin") ? next.filter((p) => p !== "admin") : normalize(next);
    const updated = await membersApi.update(project.id, m.id, perms);
    setMembers((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
    if (m.user?.id === me?.id) reloadProjects();
  };

  const remove = async (m: Member) => {
    if (!confirm(`${m.user?.name || m.email} 님을 프로젝트에서 제거할까요?\n담당 중인 일감은 '미지정'으로 바뀝니다.`)) return;
    await membersApi.remove(project.id, m.id);
    setMembers((prev) => prev.filter((x) => x.id !== m.id));
    if (m.user?.id === me?.id) reloadProjects();
  };

  const nameByUserId = new Map(members.flatMap((m) => (m.user ? [[m.user.id, m.user.name || m.user.email]] : [])));

  return (
    <div className="members">
      {isAdmin && (
        <div className="kb-bar">
          <div className="segment">
            <button aria-pressed={tab === "members"} onClick={() => setTab("members")}>
              멤버 · 권한 ({members.length})
            </button>
            <button aria-pressed={tab === "integrations"} onClick={() => setTab("integrations")}>
              연동 · 설정
            </button>
            <button aria-pressed={tab === "audit"} onClick={() => setTab("audit")}>
              감사 로그
            </button>
          </div>
        </div>
      )}

      {tab === "members" ? (
        <>
          {isAdmin ? (
            <form className="card create-card" onSubmit={add}>
              <input
                type="email"
                name="email"
                className="member-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="추가할 사람의 구글 이메일"
                required
              />
              <select className="filter-select" value={preset} onChange={(e) => setPreset(Number(e.target.value))} aria-label="권한">
                {PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
              <label className="kind-toggle">
                <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} /> 초대 메일
              </label>
              <button type="submit" className="btn btn-primary">
                <PlusIcon size={11} /> 멤버 추가
              </button>
              <span className="muted member-help">아직 가입하지 않은 사람도 추가할 수 있어요. 그 이메일로 구글 로그인하면 바로 참여됩니다.</span>
            </form>
          ) : (
            <p className="dash-sub member-readonly">멤버와 권한은 관리자만 바꿀 수 있습니다.</p>
          )}
          {notice && <p className="alert tone-done" style={{ margin: "0 0 10px" }}>{notice}</p>}
          {error && <p className="error" style={{ margin: "-4px 4px 12px" }}>{error}</p>}

          <div className="card member-table">
            <div className="member-row member-header">
              <span>멤버 {members.length}</span>
              {PERMISSIONS.map((p) => (
                <span key={p} className="perm-col" title={PERMISSION_HINT[p]}>
                  {PERMISSION_LABEL[p]}
                </span>
              ))}
              <span />
            </div>
            {members.map((m) => (
              <div key={m.id} className="member-row">
                <span className="member-who">
                  <Avatar user={m.user} size={26} />
                  <span className="member-names">
                    <strong>
                      {m.user?.name || m.email}
                      {m.user?.id === me?.id && <span className="muted"> (나)</span>}
                    </strong>
                    <span className="muted">{m.email}</span>
                  </span>
                  {m.is_owner && <span className="pill tone-run">소유자</span>}
                  {m.pending && <span className="pill tone-wait">초대됨 · 로그인 전</span>}
                </span>
                {PERMISSIONS.map((p) => (
                  <span key={p} className="perm-col">
                    <input
                      type="checkbox"
                      checked={m.permissions.includes(p)}
                      disabled={!isAdmin || m.is_owner || p === "view" || (p !== "admin" && m.permissions.includes("admin"))}
                      onChange={() => toggle(m, p)}
                      aria-label={`${m.email} ${PERMISSION_LABEL[p]}`}
                    />
                  </span>
                ))}
                <span className="member-actions">
                  {isAdmin && !m.is_owner && m.pending && (
                    <button className="btn btn-sm btn-ghost" onClick={() => resend(m)} title="초대 메일 재발송">
                      재발송
                    </button>
                  )}
                  {project.is_owner && !m.is_owner && m.user && (
                    <button className="btn btn-sm btn-ghost" onClick={() => transferOwnership(m)} title="소유권 이전">
                      소유권 이전
                    </button>
                  )}
                  {isAdmin && !m.is_owner && (
                    <button className="icon-btn danger" onClick={() => remove(m)} title="제거">
                      <TrashIcon size={13} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : tab === "integrations" ? (
        <div className="kb-section">
          {notice && <p className="alert tone-done">{notice}</p>}
          {error && <p className="error">{error}</p>}
          <form className="card mcp-connect" onSubmit={(e) => saveGitHub(e, false)}>
            <h3>GitHub Webhook 연동</h3>
            <p className="muted mcp-help">
              PR 제목·브랜치·커밋에 <code>{project.key}-12</code> 를 포함하면 일감에 자동 연결되고, PR 오픈 시 리뷰·머지 시 완료로 이동합니다.
            </p>
            {gh && (
              <div className="copy-row">
                <code className="mono">{gh.webhook_url}</code>
                <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(gh.webhook_url)}>
                  URL 복사
                </button>
              </div>
            )}
            <div className="kb-form compact" style={{ padding: 0 }}>
              <input value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="저장소 (예: athens96/MightyWork)" />
              <label className="kind-toggle">
                <input type="checkbox" checked={ghAuto} onChange={(e) => setGhAuto(e.target.checked)} /> PR/커밋 자동 단계 이동
              </label>
              <button type="submit" className="btn btn-primary">
                저장
              </button>
              {gh?.has_secret && (
                <button type="button" className="btn btn-sm" onClick={(e) => saveGitHub(e, true)}>
                  시크릿 재발급
                </button>
              )}
            </div>
          </form>

          <form className="card mcp-connect" onSubmit={addTemplate}>
            <h3>일감 템플릿 ({templates.length})</h3>
            <p className="muted mcp-help">
              단축키 <kbd>C</kbd> 빠른 생성 모달에서 템플릿을 선택하면 제목 접두어·설명·레이블·체크리스트가 자동으로 채워집니다.
            </p>
            {templates.length > 0 && (
              <div className="rows" style={{ marginBottom: 10 }}>
                {templates.map((tpl) => (
                  <div key={tpl.id} className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <strong>{tpl.name}</strong>
                      {tpl.title_prefix && <code className="mono" style={{ marginLeft: 6 }}>{tpl.title_prefix}</code>}
                      {tpl.tags.length > 0 && (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 11.5 }}>
                          #{tpl.tags.join(" #")}
                        </span>
                      )}
                      {tpl.checklist.length > 0 && (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 11.5 }}>
                          체크리스트 {tpl.checklist.length}건
                        </span>
                      )}
                    </div>
                    <button type="button" className="icon-btn danger" onClick={() => removeTemplate(tpl)} title="템플릿 삭제">
                      <TrashIcon size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="cycle-form-grid">
              <label>
                <span>템플릿 이름</span>
                <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="예: 버그 제보" required />
              </label>
              <label>
                <span>제목 접두어</span>
                <input value={tplPrefix} onChange={(e) => setTplPrefix(e.target.value)} placeholder="예: [Bug] " />
              </label>
              <label>
                <span>기본 우선순위</span>
                <select value={tplPriority} onChange={(e) => setTplPriority(e.target.value as Priority)}>
                  <option value="urgent">긴급</option>
                  <option value="high">높음</option>
                  <option value="medium">보통</option>
                  <option value="low">낮음</option>
                </select>
              </label>
              <label>
                <span>기본 레이블 (쉼표 구분)</span>
                <input value={tplTags} onChange={(e) => setTplTags(e.target.value)} placeholder="bug, triage" />
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                <span>기본 설명 (Markdown)</span>
                <textarea rows={2} value={tplDesc} onChange={(e) => setTplDesc(e.target.value)} placeholder="### 재현 경로&#10;1. " />
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                <span>기본 체크리스트 (줄바꿈으로 구분)</span>
                <textarea rows={2} value={tplCheck} onChange={(e) => setTplCheck(e.target.value)} placeholder="재현 확인&#10;회귀 테스트 작성" />
              </label>
            </div>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={!tplName.trim()}>
                <PlusIcon size={11} /> 템플릿 추가
              </button>
            </div>
          </form>

          {pipeline.length > 0 && (
            <form className="card mcp-connect" onSubmit={savePipeline}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: 0 }}>파이프라인 단계 · WIP 상한</h3>
                <button type="button" className="btn btn-sm btn-ghost" onClick={resetPipelineDefaults}>
                  기본값 불러오기
                </button>
              </div>
              <p className="muted mcp-help">
                보드 컬럼의 이름·색상·순서·숨김 여부와 컬럼별 WIP 상한을 설정합니다. 숨김 처리한 단계의 일감은 첫 표시 단계로 자동 이동됩니다.
              </p>
              <div className="pipeline-editor">
                {pipeline.map((st, idx) => (
                  <div key={st.key} className={`pipeline-row ${st.hidden ? "is-hidden" : ""}`}>
                    <span className="row" style={{ gap: 4 }}>
                      <button type="button" className="btn btn-sm btn-ghost" disabled={idx === 0} onClick={() => moveStageOrder(idx, -1)} title="위로">
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={idx === pipeline.length - 1}
                        onClick={() => moveStageOrder(idx, 1)}
                        title="아래로"
                      >
                        ↓
                      </button>
                    </span>
                    <code className="mono muted" style={{ fontSize: 11.5 }}>
                      {st.key}
                    </code>
                    <input
                      value={st.label}
                      onChange={(e) =>
                        setPipeline((prev) => prev.map((x) => (x.key === st.key ? { ...x, label: e.target.value } : x)))
                      }
                      aria-label={`${st.key} 이름`}
                    />
                    <select
                      value={st.color ?? ""}
                      onChange={(e) =>
                        setPipeline((prev) => prev.map((x) => (x.key === st.key ? { ...x, color: e.target.value } : x)))
                      }
                      aria-label={`${st.key} 색상`}
                    >
                      <option value="">기본 색상</option>
                      <option value="tone-stop">중립</option>
                      <option value="tone-idle">대기</option>
                      <option value="tone-run">진행(파랑)</option>
                      <option value="tone-wait">주의(주황)</option>
                      <option value="tone-agent">리뷰(보라)</option>
                      <option value="tone-task">QA(청록)</option>
                      <option value="tone-done">완료(초록)</option>
                      <option value="tone-err">강조(빨강)</option>
                    </select>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      placeholder="WIP 무제한"
                      value={st.wip_limit ?? ""}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        setPipeline((prev) =>
                          prev.map((x) => (x.key === st.key ? { ...x, wip_limit: v ? Math.max(1, Number(v)) : null } : x)),
                        );
                      }}
                      aria-label={`${st.key} WIP 상한`}
                    />
                    <label className="kind-toggle">
                      <input
                        type="checkbox"
                        checked={!!st.hidden}
                        onChange={(e) =>
                          setPipeline((prev) => prev.map((x) => (x.key === st.key ? { ...x, hidden: e.target.checked } : x)))
                        }
                      />{" "}
                      숨김
                    </label>
                  </div>
                ))}
              </div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
                <button type="submit" className="btn btn-primary">
                  파이프라인 저장
                </button>
              </div>
            </form>
          )}

          <form className="card mcp-connect" onSubmit={addWebhook}>
            <h3>외부 알림 Webhook (Slack · Discord · Custom)</h3>
            <p className="muted mcp-help">
              일감 생성·단계 이동·덧글·@멘션·마감 임박 이벤트를 Slack, Discord 또는 자체 서버(HMAC-SHA256 서명)로 전송합니다.
            </p>
            {webhooks.length > 0 && (
              <div className="rows" style={{ marginBottom: 12 }}>
                {webhooks.map((h) => (
                  <div key={h.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <input type="checkbox" checked={h.enabled} onChange={() => toggleWebhook(h)} title="활성/비활성" />
                        <strong>{h.name}</strong>
                        <span className="pill tone-idle">{h.preset}</span>
                        <code className="mono muted" style={{ fontSize: 11.5 }}>
                          {h.url}
                        </code>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <button type="button" className="btn btn-sm" onClick={() => sendTestWebhook(h)}>
                          테스트 발송
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => openWebhookLogs(h)}>
                          {whLogsId === h.id ? "로그 닫기" : "전송 로그"}
                        </button>
                        <button type="button" className="icon-btn danger" onClick={() => removeWebhook(h)} title="웹훅 삭제">
                          <TrashIcon size={13} />
                        </button>
                      </div>
                    </div>
                    {whLogsId === h.id && (
                      <div className="quick-tpl-check" style={{ marginTop: 4 }}>
                        {whLogs.length === 0 ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            아직 전송 이력이 없습니다.
                          </span>
                        ) : (
                          whLogs.slice(0, 8).map((d) => (
                            <div key={d.id} className="row" style={{ justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                              <span>
                                <span className={`pill ${d.ok ? "tone-done" : "tone-err"}`}>{d.ok ? `HTTP ${d.status_code ?? 200}` : d.error || "실패"}</span>{" "}
                                <code className="mono">{d.event}</code> ({d.attempts}회)
                              </span>
                              <span className="muted">{timeAgo(d.created_at)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="cycle-form-grid">
              <label>
                <span>이름</span>
                <input value={whName} onChange={(e) => setWhName(e.target.value)} placeholder="예: 개발팀 슬랙" required />
              </label>
              <label>
                <span>포맷 프리셋</span>
                <select value={whPreset} onChange={(e) => setWhPreset(e.target.value as WebhookPreset)}>
                  <option value="slack">Slack Incoming Webhook</option>
                  <option value="discord">Discord Webhook</option>
                  <option value="custom">Custom JSON (+ HMAC 서명)</option>
                </select>
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                <span>Webhook URL (https://)</span>
                <input type="url" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} placeholder="https://hooks.slack.com/services/..." required />
              </label>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              {WEBHOOK_EVENT_LABELS.map(([ev, label]) => (
                <label key={ev} className="kind-toggle">
                  <input
                    type="checkbox"
                    checked={whEvents.includes(ev)}
                    onChange={(e) =>
                      setWhEvents((prev) => (e.target.checked ? [...prev, ev] : prev.filter((x) => x !== ev)))
                    }
                  />{" "}
                  {label}
                </label>
              ))}
              <span className="spacer" />
              <button type="submit" className="btn btn-primary" disabled={!whName.trim() || !whUrl.trim()}>
                <PlusIcon size={11} /> 웹훅 등록
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="kb-section">
          <div className="kb-actions-bar">
            <select value={logFilter} onChange={(e) => setLogFilter(e.target.value)} aria-label="감사 로그 필터">
              <option value="">모든 이벤트</option>
              <option value="project">프로젝트 · 소유권</option>
              <option value="member">멤버 · 초대</option>
              <option value="task">일감</option>
              <option value="wiki">위키 · 복원</option>
              <option value="attachment">첨부 파일</option>
              <option value="knowledge">지식 추출 · 리뷰</option>
            </select>
            <button className="btn btn-sm" onClick={reloadLogs}>
              새로고침
            </button>
          </div>
          {logs.length === 0 ? (
            <div className="card empty">기록된 감사 로그가 없습니다.</div>
          ) : (
            <div className="card rows">
              {logs.map((l) => (
                <div key={l.id} className="row">
                  <span className="key-badge">{l.action}</span>
                  <span className="row-main">
                    <span className="row-title">{l.summary}</span>
                    <span className="row-meta">
                      {nameByUserId.get(l.actor_id) ?? l.actor_id} · {timeAgo(l.created_at)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
