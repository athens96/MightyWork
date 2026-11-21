import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchApi } from "../api";
import { BoardIcon, DocIcon, FolderIcon, PlusIcon, SearchIcon } from "./icons";
import type { Project, SearchHit } from "../types";

interface CmdItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: "task" | "wiki" | "project" | "action";
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  activeProjectId: string | undefined;
  onQuickCreate: () => void;
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
}

/** 전역 커맨드 팔레트 (⌘K / Ctrl+K) — Linear 스타일 탐색·액션 통합 */
export function CommandPalette({ open, onClose, projects, activeProjectId, onQuickCreate, onToggleTheme, onShowShortcuts }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open || !activeProjectId || !query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchApi.search(activeProjectId, query.trim()).then(
        (res) => !cancelled && setHits(res.slice(0, 8)),
        () => !cancelled && setHits([]),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, activeProjectId, query]);

  const items = useMemo<CmdItem[]>(() => {
    const q = query.trim().toLowerCase();
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };

    const actions: CmdItem[] = [
      {
        id: "act-create",
        group: "빠른 액션",
        label: "새 일감 만들기",
        hint: "C",
        icon: "action",
        run: () => {
          onClose();
          onQuickCreate();
        },
      },
      { id: "act-my", group: "빠른 액션", label: "내 일감 보기 (My Issues)", icon: "action", run: go("/my-tasks") },
      { id: "act-notif", group: "빠른 액션", label: "알림함 열기", icon: "action", run: go("/notifications") },
      { id: "act-apps", group: "빠른 액션", label: "연결된 앱 (MCP)", icon: "action", run: go("/settings/apps") },
      {
        id: "act-theme",
        group: "빠른 액션",
        label: "라이트 / 다크 테마 전환",
        icon: "action",
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
      {
        id: "act-keys",
        group: "빠른 액션",
        label: "키보드 단축키 보기",
        hint: "?",
        icon: "action",
        run: () => {
          onClose();
          onShowShortcuts();
        },
      },
    ];

    if (activeProject) {
      actions.push(
        { id: "cur-tasks", group: `${activeProject.key} 이동`, label: `${activeProject.name} · 일감 보드`, icon: "task", run: go(`/projects/${activeProject.id}/tasks`) },
        { id: "cur-list", group: `${activeProject.key} 이동`, label: `${activeProject.name} · 리스트 뷰`, icon: "task", run: go(`/projects/${activeProject.id}/tasks?view=list`) },
        { id: "cur-timeline", group: `${activeProject.key} 이동`, label: `${activeProject.name} · 타임라인 뷰`, icon: "task", run: go(`/projects/${activeProject.id}/tasks?view=timeline`) },
        { id: "cur-wiki", group: `${activeProject.key} 이동`, label: `${activeProject.name} · 위키`, icon: "wiki", run: go(`/projects/${activeProject.id}/wiki`) },
        { id: "cur-kb", group: `${activeProject.key} 이동`, label: `${activeProject.name} · 지식 베이스`, icon: "wiki", run: go(`/projects/${activeProject.id}/knowledge`) },
      );
    }

    const projItems: CmdItem[] = projects.map((p) => ({
      id: `proj-${p.id}`,
      group: "프로젝트",
      label: `${p.name} (${p.key})`,
      hint: "일감 보드",
      icon: "project",
      run: go(`/projects/${p.id}/tasks`),
    }));

    const searchItems: CmdItem[] = hits.map((h) => ({
      id: `hit-${h.kind}-${h.id}`,
      group: activeProject ? `${activeProject.key} 검색 결과` : "검색 결과",
      label: h.kind === "task" && h.number && activeProject ? `${activeProject.key}-${h.number} ${h.title}` : h.title,
      hint: h.kind === "task" ? "일감" : "위키",
      icon: h.kind,
      run: go(
        h.kind === "task"
          ? `/projects/${activeProjectId}/tasks/${h.id}`
          : `/projects/${activeProjectId}/wiki/${h.id}`,
      ),
    }));

    const matchedStatic = [...actions, ...projItems].filter((it) => !q || it.label.toLowerCase().includes(q) || (it.hint ?? "").toLowerCase().includes(q));
    return [...searchItems, ...matchedStatic].slice(0, 14);
  }, [query, hits, projects, activeProject, activeProjectId, navigate, onClose, onQuickCreate, onToggleTheme, onShowShortcuts]);

  useEffect(() => {
    setIndex(0);
  }, [items.length, query]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="cmd-modal" role="dialog" aria-modal="true" aria-label="커맨드 팔레트" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-row">
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (e.key === "Enter" && items[index]) {
                e.preventDefault();
                items[index].run();
              }
            }}
            placeholder={activeProject ? `${activeProject.key} 일감·위키 검색 또는 명령 입력…` : "프로젝트 이동 또는 명령 입력…"}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="cmd-list" role="listbox">
          {items.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>일치하는 항목이 없습니다.</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.id}
                type="button"
                role="option"
                aria-selected={i === index}
                className={`cmd-item ${i === index ? "active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={it.run}
              >
                <span className="cmd-icon">
                  {it.icon === "task" ? <BoardIcon size={13} /> : it.icon === "wiki" ? <DocIcon size={13} /> : it.icon === "project" ? <FolderIcon size={13} /> : <PlusIcon size={12} />}
                </span>
                <span className="cmd-label">{it.label}</span>
                <span className="muted cmd-group">{it.hint || it.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
