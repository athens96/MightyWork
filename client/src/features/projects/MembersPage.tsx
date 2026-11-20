import { useCallback, useEffect, useState, type FormEvent } from "react";
import { membersApi } from "../../api";
import { ApiError } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { Avatar } from "../../components/Avatar";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { can, normalize, PERMISSION_HINT, PERMISSION_LABEL, PERMISSIONS, PRESETS } from "../../lib/permissions";
import type { Member, Permission } from "../../types";
import { useCurrentProject } from "./ProjectLayout";
import { useProjects } from "./ProjectsContext";

/** 프로젝트 멤버·권한 관리 (변경은 관리자만) */
export function MembersPage() {
  const project = useCurrentProject();
  const { reload: reloadProjects } = useProjects();
  const { user: me } = useAuth();
  const isAdmin = can(project, "admin");
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [preset, setPreset] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => membersApi.list(project.id).then(setMembers), [project.id]);
  useEffect(() => {
    reload();
  }, [reload]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const m = await membersApi.add(project.id, email.trim(), PRESETS[preset].permissions);
      setMembers((prev) => [...prev, m]);
      setEmail("");
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

  const toggle = async (m: Member, perm: Permission) => {
    const next = m.permissions.includes(perm) ? m.permissions.filter((p) => p !== perm) : [...m.permissions, perm];
    // 관리자 해제 시에는 관리자만 빼고 나머지는 유지
    const perms = perm === "admin" && m.permissions.includes("admin") ? next.filter((p) => p !== "admin") : normalize(next);
    const updated = await membersApi.update(project.id, m.id, perms);
    setMembers((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
    if (m.user?.id === me?.id) reloadProjects(); // 내 권한이 바뀌면 화면 권한도 갱신
  };

  const remove = async (m: Member) => {
    if (!confirm(`${m.user?.name || m.email} 님을 프로젝트에서 제거할까요?\n담당 중인 일감은 '미지정'으로 바뀝니다.`)) return;
    await membersApi.remove(project.id, m.id);
    setMembers((prev) => prev.filter((x) => x.id !== m.id));
    if (m.user?.id === me?.id) reloadProjects();
  };

  return (
    <div className="members">
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
          <button type="submit" className="btn btn-primary">
            <PlusIcon size={11} /> 멤버 추가
          </button>
          <span className="muted member-help">아직 가입하지 않은 사람도 추가할 수 있어요. 그 이메일로 구글 로그인하면 바로 참여됩니다.</span>
        </form>
      ) : (
        <p className="dash-sub member-readonly">멤버와 권한은 관리자만 바꿀 수 있습니다.</p>
      )}
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
              {isAdmin && !m.is_owner && (
                <button className="icon-btn danger" onClick={() => remove(m)} title="제거">
                  <TrashIcon size={13} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
