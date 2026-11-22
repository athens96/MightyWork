import { describe, expect, it } from "vitest";
import { applyMarkdownFormat, extractHeadings, parseCalloutHeader } from "./markdownHelpers";

describe("extractHeadings", () => {
  it("코드 펜스 내부의 # 주석은 무시하고 H1~H3 목차와 고유 ID를 생성한다", () => {
    const md = [
      "# 개요",
      "본문",
      "```bash",
      "# 이건 셸 주석",
      "```",
      "## **설계** 및 [[위키|링크]]",
      "### 상세",
      "### 상세",
      "#### H4는 제외",
    ].join("\n");

    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "개요", id: "h-개요" },
      { level: 2, text: "설계 및 링크", id: "h-설계-및-링크" },
      { level: 3, text: "상세", id: "h-상세" },
      { level: 3, text: "상세", id: "h-상세-2" },
    ]);
  });
});

describe("parseCalloutHeader", () => {
  it("GitHub/Obsidian 콜아웃 종류와 커스텀 제목·본문을 파싱한다", () => {
    const w = parseCalloutHeader("[!WARNING] 배포 주의\n본문 둘째 줄");
    expect(w).not.toBeNull();
    expect(w!.meta.kind).toBe("warning");
    expect(w!.meta.label).toBe("주의");
    expect(w!.customTitle).toBe("배포 주의");
    expect(w!.rest).toBe("본문 둘째 줄");

    expect(parseCalloutHeader("[!tip]\n간단한 팁")?.meta.kind).toBe("tip");
    expect(parseCalloutHeader("일반 인용문")).toBeNull();
  });
});

describe("applyMarkdownFormat", () => {
  it("선택한 텍스트를 굵게 감싸고 선택 범위를 유지한다", () => {
    const r = applyMarkdownFormat("안녕 세상아", 3, 5, "bold");
    expect(r.next).toBe("안녕 **세상**아");
    expect(r.next.slice(r.selStart, r.selEnd)).toBe("세상");
  });

  it("콜아웃과 체크리스트를 줄 시작에 깔끔히 삽입한다", () => {
    const c = applyMarkdownFormat("첫 줄", 3, 3, "callout");
    expect(c.next).toContain("\n> [!NOTE]\n> ");

    const ck = applyMarkdownFormat("작업 A\n작업 B", 0, 9, "checklist");
    expect(ck.next).toBe("- [ ] 작업 A\n- [ ] 작업 B");
  });
});
