import { describe, expect, it } from "vitest";
import { hasTaskKey, injectTaskKeyIntoChecklist, injectTaskKeyIntoSelection } from "./wikiToTask";

describe("wikiToTask", () => {
  it("detects existing project task keys", () => {
    expect(hasTaskKey("API 설계 마무리 (MW-12)", "MW")).toBe(true);
    expect(hasTaskKey("API 설계 마무리", "MW")).toBe(false);
    expect(hasTaskKey("OTHER-12 항목", "MW")).toBe(false);
  });

  it("injects task key into matching checklist line outside code blocks", () => {
    const md = [
      "```md",
      "- [ ] 배포 스크립트 점검",
      "```",
      "",
      "## 할 일",
      "- [ ] **배포 스크립트** 점검",
      "- [ ] 모니터링 설정",
    ].join("\n");

    const updated = injectTaskKeyIntoChecklist(md, "배포 스크립트 점검", "MW-21");
    expect(updated).toContain("```md\n- [ ] 배포 스크립트 점검\n```");
    expect(updated).toContain("- [ ] **배포 스크립트** 점검 (MW-21)");
  });

  it("injects task key right after selected text or falls back gracefully", () => {
    const md = "회의에서 결제 타임아웃 버그 수정이 필요하다고 결정했다.";
    expect(injectTaskKeyIntoSelection(md, "결제 타임아웃 버그 수정", "MW-30")).toBe(
      "회의에서 결제 타임아웃 버그 수정 (MW-30)이 필요하다고 결정했다.",
    );
    expect(injectTaskKeyIntoSelection(md, "존재하지 않는 텍스트", "MW-31")).toContain("- 관련 일감: MW-31");
  });
});
