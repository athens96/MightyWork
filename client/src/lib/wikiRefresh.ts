export type WikiRefreshPlan = {
  tree: boolean;
  page: boolean;
  links: boolean;
  comments: boolean;
};

/**
 * 프로젝트 SSE 이벤트를 받아 위키 화면에서 어떤 데이터를 갱신할지 결정한다.
 */
export function planWikiRefresh(event: string, data: Record<string, unknown>, activePageId: string | undefined): WikiRefreshPlan {
  if (event.startsWith("wiki.comment_")) {
    const match = Boolean(activePageId && data.page_id === activePageId);
    return { tree: false, page: false, links: false, comments: match };
  }
  if (event.startsWith("wiki.")) {
    const hasActive = Boolean(activePageId);
    const samePage = Boolean(activePageId && (!data.page_id || data.page_id === activePageId));
    return {
      tree: true,
      page: samePage,
      links: hasActive,
      comments: false,
    };
  }
  if (event.startsWith("task.")) {
    return {
      tree: false,
      page: false,
      links: Boolean(activePageId),
      comments: false,
    };
  }
  return { tree: false, page: false, links: false, comments: false };
}

/**
 * 백그라운드 갱신 시 현재 편집 중인 초안을 보호해야 하는지 판정한다.
 * - 편집 중이 아니면 최신 문서로 즉시 교체 ("replace")
 * - 편집 중이고 원격 updated_at 이 바뀌었으면 초안 유지 + 충돌 배너 표시 ("conflict")
 * - 편집 중이지만 원격 변경이 없으면 아무것도 하지 않음 ("noop")
 */
export function decidePageSyncAction(
  editing: boolean,
  currentUpdatedAt: string | null | undefined,
  latestUpdatedAt: string,
): "replace" | "conflict" | "noop" {
  if (!editing) return "replace";
  if (currentUpdatedAt && currentUpdatedAt !== latestUpdatedAt) return "conflict";
  return "noop";
}
