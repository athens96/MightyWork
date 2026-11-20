import { useState } from "react";
import { Link, NavLink, Outlet, useMatch } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useProjects } from "../features/projects/ProjectsContext";
import { useTheme } from "../theme";
import { BoardIcon, DocIcon, FolderIcon, GridIcon, LogoutIcon, MoonIcon, PlugIcon, PlusIcon, SearchIcon, SunIcon } from "./icons";

/** MightyCode 사이드바: 검색 → 홈 행 → 섹션 머리 → 프로젝트 행(+하위 일감/위키) → 하단 바 */
export function Layout() {
  const { user, logout } = useAuth();
  const { projects } = useProjects();
  const [theme, toggleTheme] = useTheme();
  const [query, setQuery] = useState("");
  const activeProjectId = useMatch("/projects/:projectId/*")?.params.projectId;

  const q = query.trim().toLowerCase();
  const visible = q ? projects.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(q)) : projects;

  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/projects" className="side-brand" title="MightyWork">
          <img src="/logo.png" alt="" width={22} height={22} />
          MightyWork
        </Link>
        <label className="side-search">
          <SearchIcon size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="프로젝트 검색" />
        </label>

        <NavLink to="/projects" end className="side-home">
          <span className="tile-icon">
            <GridIcon size={11} />
          </span>
          전체 프로젝트
          <span className="side-count">{projects.length}</span>
        </NavLink>

        <div className="side-section">
          프로젝트 <span className="mono">{projects.length}</span>
        </div>

        <nav className="side-list">
          {visible.map((p) => (
            <div key={p.id}>
              <NavLink to={`/projects/${p.id}`} className="side-row" title={p.name}>
                <FolderIcon size={14} />
                <span className="name">{p.name}</span>
                <span className="key">{p.key}</span>
              </NavLink>
              {p.id === activeProjectId && (
                <>
                  <NavLink to={`/projects/${p.id}/tasks`} className="side-sub">
                    <BoardIcon size={13} /> 일감
                  </NavLink>
                  <NavLink to={`/projects/${p.id}/wiki`} className="side-sub">
                    <DocIcon size={13} /> 위키
                  </NavLink>
                </>
              )}
            </div>
          ))}
          <Link to="/projects#new" className="side-add">
            <PlusIcon size={10} /> 프로젝트 추가
          </Link>
        </nav>

        <div className="side-footer">
          {user?.picture ? (
            <img src={user.picture} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="avatar-fallback">{(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</span>
          )}
          <span className="who" title={user?.email}>
            {user?.name || user?.email}
          </span>
          <NavLink to="/settings/apps" className="icon-btn" title="연결된 앱 (MCP)">
            <PlugIcon />
          </NavLink>
          <button className="icon-btn" onClick={toggleTheme} title={theme === "dark" ? "라이트 모드" : "다크 모드"}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="icon-btn" onClick={logout} title="로그아웃">
            <LogoutIcon />
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
