import { NavLink } from "react-router-dom";
import { DocIcon } from "../../components/icons";
import type { WikiPageSummary } from "../../types";

interface Props {
  pages: WikiPageSummary[];
  basePath: string; // 예: /projects/:id/wiki
  parentId?: string | null;
}

/** parent_id 기반 페이지 트리 */
export function WikiTree({ pages, basePath, parentId = null }: Props) {
  const children = pages.filter((p) => p.parent_id === parentId);
  if (children.length === 0) return null;

  return (
    <ul className="tree">
      {children.map((page) => (
        <li key={page.id}>
          <NavLink to={`${basePath}/${page.id}`} title={page.title} className={page.status === "deprecated" ? "is-deprecated" : undefined}>
            <DocIcon size={13} />
            <span>{page.title}</span>
          </NavLink>
          <WikiTree pages={pages} basePath={basePath} parentId={page.id} />
        </li>
      ))}
    </ul>
  );
}
