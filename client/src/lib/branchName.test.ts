import { describe, expect, it } from "vitest";
import { makeBranchName } from "./branchName";

describe("makeBranchName", () => {
  it("builds feat/fix branch slugs cleanly", () => {
    expect(makeBranchName("MW", 4, "GitHub Webhook Integration")).toBe("feat/mw-4-github-webhook-integration");
    expect(makeBranchName("MW", 9, "로그인 오류 수정", ["bug"])).toBe("fix/mw-9");
    expect(makeBranchName("MW", 12, "Fix OAuth redirect")).toBe("fix/mw-12-fix-oauth-redirect");
  });
});
