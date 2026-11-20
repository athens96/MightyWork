/**
 * 마크다운 텍스트 속 [[페이지 제목]] / [[제목|표시 텍스트]] 와 일감 키(KEY-12)를 링크로 바꾸는 remark 플러그인.
 * 코드·인라인 코드·기존 링크 안은 건드리지 않는다. 판정 규칙은 서버 app/services/links.py 와 같다.
 */

export interface LinkResolver {
  projectId: string;
  projectKey: string;
  pageId: (title: string) => string | undefined;
  task: (number: number) => { id: string; title: string; stage: string } | undefined;
  onMissing?: (title: string) => void; // 없는 페이지 클릭 시 (생성 권한 있을 때만)
}

export const MISSING_PREFIX = "/__wiki_new__/";

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
};

export const normTitle = (t: string) => t.split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function remarkWikiLinks(resolver: LinkResolver) {
  const pattern = new RegExp(
    String.raw`\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]|(?<![A-Za-z0-9_-])${escapeRe(resolver.projectKey)}-(\d+)(?![A-Za-z0-9_])`,
    "g",
  );

  const link = (url: string, text: string, className: string, title?: string): MdNode => ({
    type: "link",
    url,
    title: title ?? null,
    children: [{ type: "text", value: text }],
    data: { hProperties: { className } },
  });

  const split = (text: string): MdNode[] => {
    const out: MdNode[] = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      if (start > last) out.push({ type: "text", value: text.slice(last, start) });
      if (m[1] !== undefined) {
        const title = m[1].trim();
        const label = m[2]?.trim() || title;
        const id = resolver.pageId(title);
        out.push(
          id
            ? link(`/projects/${resolver.projectId}/wiki/${id}`, label, "wikilink")
            : link(MISSING_PREFIX + encodeURIComponent(title), label, "wikilink missing", `없는 페이지: ${title}`),
        );
      } else {
        const t = resolver.task(Number(m[3]));
        out.push(
          t
            ? link(`/projects/${resolver.projectId}/tasks/${t.id}`, m[0], `issue-link stage-${t.stage}`, `${m[0]} · ${t.title}`)
            : { type: "text", value: m[0] },
        );
      }
      last = start + m[0].length;
    }
    if (last < text.length) out.push({ type: "text", value: text.slice(last) });
    return out;
  };

  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value) return split(child.value);
      walk(child);
      return [child];
    });
  };

  return () => (tree: MdNode) => walk(tree);
}
