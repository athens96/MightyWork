import { useEffect, useMemo, useState } from "react";
import { tasksApi, wikiApi } from "../api";
import type { Project, Task, WikiPageSummary } from "../types";
import { normTitle, type LinkResolver } from "./wikilinks";

/**
 * 프로젝트의 위키 제목·일감 번호로 링크 해석기를 만든다.
 * 이미 가진 목록(pages/tasks)을 넘기면 다시 불러오지 않는다.
 */
export function useLinkResolver(
  project: Project,
  opts: { pages?: WikiPageSummary[]; tasks?: Task[]; onMissing?: (title: string) => void } = {},
): LinkResolver {
  const [fetchedPages, setFetchedPages] = useState<WikiPageSummary[]>([]);
  const [fetchedTasks, setFetchedTasks] = useState<Task[]>([]);
  const needPages = !opts.pages;
  const needTasks = !opts.tasks;

  useEffect(() => {
    if (needPages) wikiApi.list(project.id).then(setFetchedPages, () => {});
    if (needTasks) tasksApi.list(project.id).then(setFetchedTasks, () => {});
  }, [project.id, needPages, needTasks]);

  const pages = opts.pages ?? fetchedPages;
  const tasks = opts.tasks ?? fetchedTasks;
  const { onMissing } = opts;

  return useMemo(() => {
    // 제목이 별칭보다 우선 (서버 pages_by_title 과 같은 규칙)
    const byTitle = new Map<string, string>();
    for (const p of pages) if (!byTitle.has(normTitle(p.title))) byTitle.set(normTitle(p.title), p.id);
    for (const p of pages) for (const a of p.aliases ?? []) if (!byTitle.has(normTitle(a))) byTitle.set(normTitle(a), p.id);
    const byNumber = new Map(tasks.map((t) => [t.number, t]));
    return {
      projectId: project.id,
      projectKey: project.key,
      pageId: (title) => byTitle.get(normTitle(title)),
      task: (n) => byNumber.get(n),
      onMissing,
    };
  }, [pages, tasks, project.id, project.key, onMissing]);
}
