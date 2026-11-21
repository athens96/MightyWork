import { useCallback, useEffect, useState, type FormEvent } from "react";
import { githubApi, membersApi, projectsApi } from "../../api";
import { ApiError } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { Avatar } from "../../components/Avatar";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { can, normalize, PERMISSION_HINT, PERMISSION_LABEL, PERMISSIONS, PRESETS } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import type { AuditLog, GitHubConfig, Member, Permission } from "../../types";
import { useCurrentProject } from "./ProjectLayout";
import { useProjects } from "./ProjectsContext";

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
    }
  }, [tab, reloadLogs, project.id]);

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
