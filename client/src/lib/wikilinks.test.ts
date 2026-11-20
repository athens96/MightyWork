import { describe, expect, it } from "vitest";
import { MISSING_PREFIX, normTitle, remarkWikiLinks, type LinkResolver } from "./wikilinks";

const resolver: LinkResolver = {
  projectId: "p1",
  projectKey: "MW",
  pageId: (title) => ({ "개발 가이드": "pg-1", sso: "pg-2" })[normTitle(title)],
  task: (n) => (n === 12 ? { id: "t-12", title: "로그인 개선", stage: "in_progress" } : undefined),
};

function runPlugin(children: any[]) {
  const tree = { type: "root", children };
  remarkWikiLinks(resolver)()(tree);
  return tree;
}

describe("wikilinks", () => {
  it("normalizes whitespace and case", () => {
    expect(normTitle("  개발   가이드  ")).toBe("개발 가이드");
    expect(normTitle("SSO")).toBe("sso");
  });

  it("resolves existing, aliased, missing wiki links and task keys", () => {
    const tree = runPlugin([
      {
        type: "paragraph",
        children: [{ type: "text", value: "참고: [[개발 가이드]], [[SSO|인증]], [[없는 문서]], MW-12, MW-99, XMW-12" }],
      },
    ]);
    const nodes = tree.children[0].children;
    const links = nodes.filter((n: any) => n.type === "link");

    expect(links.map((l: any) => [l.url, l.children[0].value, l.data.hProperties.className])).toEqual([
      ["/projects/p1/wiki/pg-1", "개발 가이드", "wikilink"],
      ["/projects/p1/wiki/pg-2", "인증", "wikilink"],
      [MISSING_PREFIX + encodeURIComponent("없는 문서"), "없는 문서", "wikilink missing"],
      ["/projects/p1/tasks/t-12", "MW-12", "issue-link stage-in_progress"],
    ]);
    // 존재하지 않는 일감 번호나 접두어가 다른 문자열은 평문 유지
    const plainText = nodes.filter((n: any) => n.type === "text").map((n: any) => n.value).join("");
    expect(plainText).toContain("MW-99");
    expect(plainText).toContain("XMW-12");
  });

  it("does not rewrite inside existing markdown links or code nodes", () => {
    const tree = runPlugin([
      { type: "link", url: "https://example.com", children: [{ type: "text", value: "[[개발 가이드]] MW-12" }] },
      { type: "inlineCode", value: "[[개발 가이드]] MW-12" },
    ]);
    expect(tree.children[0].children).toEqual([{ type: "text", value: "[[개발 가이드]] MW-12" }]);
    expect(tree.children[1]).toEqual({ type: "inlineCode", value: "[[개발 가이드]] MW-12" });
  });
});
