import { describe, expect, it } from "vitest";
import { applySuggest, detectSuggest, filterSuggestions } from "./editorSuggest";
import type { User, WikiPageSummary } from "../types";

const pages: WikiPageSummary[] = [
  { id: "p1", title: "인증 설계", parent_id: null, aliases: ["SSO"], page_type: "spec", status: "published", owner_id: null, tags: [], updated_at: "2026-01-01T00:00:00Z" },
  { id: "p2", title: "배포 가이드", parent_id: null, aliases: [], page_type: "guide", status: null, owner_id: null, tags: [], updated_at: "2026-01-01T00:00:00Z" },
];

const users: User[] = [
  { id: "u1", email: "alice@example.com", name: "앨리스", picture: null, created_at: "", updated_at: "", last_login_at: null },
  { id: "u2", email: "bob@example.com", name: "밥", picture: null, created_at: "", updated_at: "", last_login_at: null },
];

describe("editorSuggest", () => {
  it("detects open [[ wiki links and filters by title or alias", () => {
    const text = "참고 [[sso";
    const match = detectSuggest(text, text.length);
    expect(match).toEqual({ kind: "wiki", start: 3, end: 8, query: "sso" });
    const items = filterSuggestions(match, pages, users);
    expect(items.map((i) => i.insert)).toEqual(["[[인증 설계]]"]);
    const applied = applySuggest("참고 [[sso]] 끝", match!, items[0].insert);
    expect(applied.value).toBe("참고 [[인증 설계]] 끝");
  });

  it("detects @ mentions and applies email insertion", () => {
    const text = "확인 부탁 @al";
    const match = detectSuggest(text, text.length);
    expect(match).toEqual({ kind: "mention", start: 6, end: 9, query: "al" });
    const items = filterSuggestions(match, pages, users);
    expect(items.map((i) => i.insert)).toEqual(["@alice@example.com "]);
    expect(applySuggest(text, match!, items[0].insert).value).toBe("확인 부탁 @alice@example.com ");
  });

  it("ignores email addresses in the middle of words", () => {
    const text = "user@example";
    expect(detectSuggest(text, text.length)).toBeNull();
  });
});
