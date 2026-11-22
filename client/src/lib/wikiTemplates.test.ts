import { describe, expect, it } from "vitest";
import { collectDescendantIds, WIKI_TEMPLATES } from "./wikiTemplates";

describe("wikiTemplates & collectDescendantIds", () => {
  it("5종의 내장 위키 템플릿이 제목과 마크다운 본문을 생성한다", () => {
    expect(WIKI_TEMPLATES.length).toBe(5);
    const meeting = WIKI_TEMPLATES.find((t) => t.id === "meeting")!;
    expect(meeting.makeTitle("2026-11-22")).toBe("회의록 2026-11-22");
    expect(meeting.makeContent("2026-11-22")).toContain("- [ ]");
    const adr = WIKI_TEMPLATES.find((t) => t.id === "adr")!;
    expect(adr.makeContent("2026-11-22")).toContain("[!IMPORTANT]");
  });

  it("자신과 모든 자손 페이지 ID를 정확히 수집해 순환 이동을 막는다", () => {
    const pages = [
      { id: "a", parent_id: null },
      { id: "b", parent_id: "a" },
      { id: "c", parent_id: "b" },
      { id: "d", parent_id: null },
    ];
    expect([...collectDescendantIds(pages, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...collectDescendantIds(pages, "d")]).toEqual(["d"]);
  });
});
