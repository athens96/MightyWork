import { useState, type FormEvent } from "react";
import { NavLink, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { projectsApi } from "../../api";
import { OPEN_COMMAND_EVENT } from "../../components/Layout";
import { BoardIcon, CalendarIcon, DocIcon, GraphIcon, SearchIcon, TrashIcon, UsersIcon } from "../../components/icons";
import { roleLabel } from "../../lib/permissions";
import type { Project } from "../../types";
import { useProjects } from "./ProjectsContext";

/** /projects/:projectId 하위 화면(일감, 위키)의 공통 헤더 + 보기 스위치 */
export function ProjectLayout() {
  const { projectId } = useParams();
  const { projects, loading, reload } = useProjects();
  const navigate = useNavigate();
  const project = projects.find((p) => p.id === projectId);
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");

  if (loading) return <p className="muted">불러오는 중…</p>;
  if (!project) return <div className="card empty">프로젝트를 찾을 수 없습니다.</div>;

  const search = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) navigate(`/projects/${project.id}/search?${new URLSearchParams({ q: query.trim() })}`);
  };

  const remove = async () => {
    if (!confirm(`"${project.name}" 프로젝트를 삭제할까요?\n일감과 위키 페이지가 모두 함께 삭제됩니다.`)) return;
    await projectsApi.remove(project.id);
    await reload();
    navigate("/projects");
  };

  return (
    <div className="project">
      <header className="project-head">
        <div className="titles">
          <div className="title-line">
            <h1>{project.name}</h1>
            <span className="key-badge">{project.key}</span>
            <span className={`pill ${project.is_owner || project.my_permissions.includes("admin") ? "tone-run" : "tone-stop"}`}>
              {roleLabel(project)}
            </span>
          </div>
          {project.description && <p className="dash-sub">{project.description}</p>}
        </div>
        <form className="project-search" onSubmit={search} role="search">
          <SearchIcon size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="일감·위키 검색" aria-label="프로젝트 검색" />
          <kbd onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_EVENT))} title="전역 커맨드 팔레트 열기" style={{ cursor: "pointer" }}>
            ⌘K
          </kbd>
        </form>
        <nav className="segment">
          <NavLink to="tasks">
            <BoardIcon size={12} /> 일감
          </NavLink>
          <NavLink to="cycles">
            <CalendarIcon size={12} /> 사이클
          </NavLink>
          <NavLink to="wiki">
            <DocIcon size={12} /> 위키
          </NavLink>
          <NavLink to="knowledge">
            <GraphIcon size={12} /> 지식
          </NavLink>
          <NavLink to="members">
            <UsersIcon size={12} /> 멤버
          </NavLink>
        </nav>
        {project.is_owner && (
          <button className="icon-btn danger" onClick={remove} title="프로젝트 삭제 (소유자만)">
            <TrashIcon />
          </button>
        )}
      </header>
      {/* key: 프로젝트가 바뀌면 하위 화면 상태를 초기화 */}
      <Outlet key={project.id} context={project} />
    </div>
  );
}

/** ProjectLayout 하위 화면에서 현재 프로젝트를 가져온다 */
export function useCurrentProject(): Project {
  return useOutletContext<Project>();
}
