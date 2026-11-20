import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { projectsApi } from "../../api";
import { ApiError } from "../../api/http";
import { BoardIcon, DocIcon, PlusIcon } from "../../components/icons";
import { roleLabel } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import { useProjects } from "./ProjectsContext";

/** 작업 현황(대시보드) 형식의 프로젝트 목록 */
export function ProjectListPage() {
  const { projects, loading, reload } = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const keyInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ key: "", name: "", description: "" });
  const [error, setError] = useState<string | null>(null);

  // 사이드바 "프로젝트 추가"(#new)로 들어오면 생성 폼에 포커스
  useEffect(() => {
    if (location.hash === "#new") keyInput.current?.focus();
  }, [location.hash]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const project = await projectsApi.create({ ...form, key: form.key.toUpperCase() });
      await reload();
      navigate(`/projects/${project.id}/tasks`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError("이미 사용 중인 프로젝트 키입니다.");
      else if (err instanceof ApiError && err.status === 422) setError("키는 영문 대문자로 시작하는 2~10자(영문/숫자)여야 합니다.");
      else setError("프로젝트 생성에 실패했습니다.");
    }
  };

  const issued = projects.reduce((sum, p) => sum + p.task_seq, 0);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1 className="dash-title">전체 프로젝트</h1>
          <p className="dash-sub">
            프로젝트 {projects.length}개 · 발급된 일감 {issued}건 · 만든 순으로 정렬
          </p>
        </div>
      </header>

      <form onSubmit={create} className="card create-card">
        <input
          ref={keyInput}
          name="key"
          value={form.key}
          onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
          placeholder="키 (예: MW)"
          maxLength={10}
          required
        />
        <input
          name="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="프로젝트 이름"
          required
        />
        <input
          name="description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="설명 (선택)"
        />
        <button type="submit" className="btn btn-primary">
          <PlusIcon size={11} /> 프로젝트 만들기
        </button>
      </form>
      {error && <p className="error" style={{ margin: "-4px 4px 12px" }}>{error}</p>}

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : projects.length === 0 ? (
        <div className="card empty">아직 프로젝트가 없습니다. 위에서 첫 프로젝트를 만들어 보세요.</div>
      ) : (
        <div className="card rows">
          {projects.map((p) => (
            <div key={p.id} className="row">
              <span className="key-badge">{p.key}</span>
              <Link to={`/projects/${p.id}/tasks`} className="row-main">
                <span className="row-title">
                  {p.name} <span className={`pill ${p.is_owner || p.my_permissions.includes("admin") ? "tone-run" : "tone-stop"}`}>{roleLabel(p)}</span>
                </span>
                <span className="row-meta">
                  {p.description ? `${p.description} · ` : ""}일감 {p.task_seq}건 · {timeAgo(p.created_at)} 생성
                </span>
              </Link>
              <div className="row-actions">
                <Link to={`/projects/${p.id}/wiki`} className="btn btn-sm">
                  <DocIcon size={12} /> 위키
                </Link>
                <Link to={`/projects/${p.id}/tasks`} className="btn btn-sm btn-primary">
                  <BoardIcon size={12} /> 일감 보드
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
