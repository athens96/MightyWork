import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch } from "react-router-dom";
import { notificationsApi } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useProjects } from "../features/projects/ProjectsContext";
import { subscribeSSE } from "../lib/sse";
import { APP_VERSION } from "../lib/version";
import { useTheme } from "../theme";
import { CommandPalette } from "./CommandPalette";
import { QuickCreateModal, ShortcutsModal } from "./QuickCreateModal";
import { BellIcon, BoardIcon, CalendarIcon, CheckSquareIcon, CloseIcon, DocIcon, FolderIcon, GraphIcon, GridIcon, LogoutIcon, MenuIcon, MoonIcon, PlugIcon, PlusIcon, SearchIcon, SunIcon } from "./icons";

export const OPEN_COMMAND_EVENT = "mightywork:open-command";

/** MightyCode 사이드바: 검색 → 홈 행 → 섹션 머리 → 프로젝트 행(+하위 일감/위키/지식) → 하단 바 */
export function Layout() {
  const { user, logout } = useAuth();
  const { projects } = useProjects();
  const [theme, toggleTheme] = useTheme();
  const [query, setQuery] = useState("");
  const [unread, setUnread] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const activeProjectId = useMatch("/projects/:projectId/*")?.params.projectId;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    setDrawerOpen(false);
    notificationsApi.list(true).then((r) => setUnread(r.unread_count), () => {});
  }, [location.pathname]);

  useEffect(() => {
    if (!user) return;
    const fetchUnread = () => notificationsApi.list(true).then((r) => setUnread(r.unread_count), () => {});
    const stopSSE = subscribeSSE(
      "/events",
      (msg) => {
        if (msg.event === "notification.created") fetchUnread();
      },
      undefined,
      fetchUnread,
    );
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) fetchUnread();
    }, 60_000);
    return () => {
      window.clearInterval(id);
      stopSSE();
    };
  }, [user?.id]);

  useEffect(() => {
    const onOpenCmd = () => setCmdOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        setCmdOpen(false);
        setQuickOpen(false);
        setKeysOpen(false);
        setDrawerOpen(false);
        return;
      }
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']");
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setKeysOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_EVENT, onOpenCmd);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_EVENT, onOpenCmd);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const visible = q ? projects.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(q)) : projects;

  return (
    <div className="app">
      <header className="mobile-topbar">
        <button type="button" className="icon-btn mobile-menu-btn" onClick={() => setDrawerOpen(true)} aria-label="메뉴 열기">
          <MenuIcon size={18} />
        </button>
        <Link to={activeProject ? `/projects/${activeProject.id}/tasks` : "/projects"} className="mobile-brand">
          <img src="/favicon.svg" alt="" width={20} height={20} />
          <span className="mobile-brand-title">{activeProject ? activeProject.name : "MightyWork"}</span>
          {activeProject && <span className="key-badge">{activeProject.key}</span>}
        </Link>
        <div className="mobile-top-actions">
          <button type="button" className="icon-btn" onClick={() => setCmdOpen(true)} aria-label="검색" title="검색 (⌘K)">
            <SearchIcon size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={() => setQuickOpen(true)} aria-label="새 일감" title="빠른 일감 생성 (C)">
            <PlusIcon size={16} />
          </button>
          <NavLink to="/notifications" className="icon-btn notif-btn" aria-label="알림" title={`알림${unread ? ` (${unread})` : ""}`}>
            <BellIcon size={16} />
            {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
          </NavLink>
        </div>
      </header>
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${drawerOpen ? "is-open" : ""}`}>
        <div className="side-brand-row">
          <Link to="/projects" className="side-brand" title={`MightyWork v${APP_VERSION}`}>
            <img src="/favicon.svg" alt="" width={22} height={22} />
            MightyWork
            <span className="brand-ver">v{APP_VERSION}</span>
          </Link>
          <button type="button" className="icon-btn mobile-close-btn" onClick={() => setDrawerOpen(false)} aria-label="메뉴 닫기">
            <CloseIcon size={15} />
          </button>
        </div>
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
        <NavLink to="/my-tasks" className="side-home">
          <span className="tile-icon">
            <CheckSquareIcon size={11} />
          </span>
          내 일감
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
                  <NavLink to={`/projects/${p.id}/cycles`} className="side-sub">
                    <CalendarIcon size={13} /> 사이클 · 로드맵
                  </NavLink>
                  <NavLink to={`/projects/${p.id}/wiki`} className="side-sub">
                    <DocIcon size={13} /> 위키
                  </NavLink>
                  <NavLink to={`/projects/${p.id}/knowledge`} className="side-sub">
                    <GraphIcon size={13} /> 지식 베이스
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
          <NavLink to="/notifications" className="icon-btn notif-btn" title={`알림${unread ? ` (${unread})` : ""}`}>
            <BellIcon />
            {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
          </NavLink>
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
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        projects={projects}
        activeProjectId={activeProjectId}
        onQuickCreate={() => setQuickOpen(true)}
        onToggleTheme={toggleTheme}
        onShowShortcuts={() => setKeysOpen(true)}
      />
      <QuickCreateModal open={quickOpen} onClose={() => setQuickOpen(false)} projects={projects} defaultProjectId={activeProjectId} />
      <ShortcutsModal open={keysOpen} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
