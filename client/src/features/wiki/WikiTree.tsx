import { useEffect, useState, type DragEvent } from "react";
import { NavLink } from "react-router-dom";
import { ChevronIcon, DocIcon } from "../../components/icons";
import { collectDescendantIds } from "../../lib/wikiTemplates";
import type { WikiPageSummary } from "../../types";

interface Props {
  projectId: string;
  pages: WikiPageSummary[];
  basePath: string; // 예: /projects/:id/wiki
  canEdit?: boolean;
  onMovePage?: (pageId: string, newParentId: string | null) => void;
}

function loadCollapsed(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`mw:wiki-tree:${projectId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr as string[]) : new Set();
  } catch {
    return new Set();
  }
}

/** parent_id 기반 접이식 페이지 트리 + 드래그앤드롭 상위 페이지 이동 */
export function WikiTree({ projectId, pages, basePath, canEdit = false, onMovePage }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(projectId));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | "__root__" | null>(null);

  useEffect(() => {
    setCollapsed(loadCollapsed(projectId));
  }, [projectId]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(`mw:wiki-tree:${projectId}`, JSON.stringify([...next]));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const canDropInto = (dragId: string | null, targetParentId: string | null): boolean => {
    if (!dragId || !canEdit || !onMovePage) return false;
    const dragged = pages.find((p) => p.id === dragId);
    if (!dragged || dragged.parent_id === targetParentId) return false;
    if (targetParentId === null) return true;
    return !collectDescendantIds(pages, dragId).has(targetParentId);
  };

  const handleDrop = (e: DragEvent, targetParentId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const dragId = e.dataTransfer.getData("text/plain") || draggingId;
    setDropTargetId(null);
    setDraggingId(null);
    if (dragId && canDropInto(dragId, targetParentId)) {
      onMovePage!(dragId, targetParentId);
      if (targetParentId && collapsed.has(targetParentId)) {
        toggle(targetParentId);
      }
    }
  };

  const renderBranch = (parentId: string | null) => {
    const children = pages.filter((p) => p.parent_id === parentId);
    if (children.length === 0) return null;

    return (
      <ul className="tree">
        {children.map((page) => {
          const hasKids = pages.some((p) => p.parent_id === page.id);
          const isCollapsed = collapsed.has(page.id);
          const isDrop = dropTargetId === page.id;
          return (
            <li key={page.id}>
              <div
                className={`tree-row ${isDrop ? "is-drop-target" : ""} ${draggingId === page.id ? "is-dragging" : ""}`}
                onDragOver={(e) => {
                  if (!canDropInto(draggingId, page.id)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dropTargetId !== page.id) setDropTargetId(page.id);
                }}
                onDragLeave={() => setDropTargetId((cur) => (cur === page.id ? null : cur))}
                onDrop={(e) => handleDrop(e, page.id)}
              >
                {hasKids ? (
                  <button
                    type="button"
                    className="tree-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={isCollapsed ? `${page.title} 하위 펼치기` : `${page.title} 하위 접기`}
                    onClick={() => toggle(page.id)}
                  >
                    <ChevronIcon size={9} className={!isCollapsed ? "is-open" : ""} />
                  </button>
                ) : (
                  <span className="tree-spacer" aria-hidden="true" />
                )}
                <NavLink
                  to={`${basePath}/${page.id}`}
                  title={canEdit ? `${page.title} (드래그해 상위 페이지 이동)` : page.title}
                  className={({ isActive }) =>
                    `${isActive ? "active" : ""} ${page.status === "deprecated" ? "is-deprecated" : ""}`.trim()
                  }
                  draggable={canEdit && !!onMovePage}
                  onDragStart={(e) => {
                    if (!canEdit || !onMovePage) return;
                    e.dataTransfer.setData("text/plain", page.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingId(page.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropTargetId(null);
                  }}
                >
                  <DocIcon size={13} />
                  <span>{page.title}</span>
                </NavLink>
              </div>
              {hasKids && !isCollapsed && renderBranch(page.id)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <>
      {draggingId && canDropInto(draggingId, null) && (
        <div
          className={`tree-root-drop ${dropTargetId === "__root__" ? "is-drop-target" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropTargetId !== "__root__") setDropTargetId("__root__");
          }}
          onDragLeave={() => setDropTargetId((cur) => (cur === "__root__" ? null : cur))}
          onDrop={(e) => handleDrop(e, null)}
        >
          여기에 놓아 최상위(루트)로 이동
        </div>
      )}
      {renderBranch(null)}
    </>
  );
}
