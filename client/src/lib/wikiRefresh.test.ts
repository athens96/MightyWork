import { describe, expect, it } from "vitest";
import { decidePageSyncAction, planWikiRefresh } from "./wikiRefresh";

describe("planWikiRefresh", () => {
  it("wiki.created refreshes tree and active page links without replacing another open page", () => {
    expect(planWikiRefresh("wiki.created", { page_id: "p2" }, "p1")).toEqual({
      tree: true,
      page: false,
      links: true,
      comments: false,
    });
  });

  it("wiki.updated refreshes tree, active page, and links when active page matches", () => {
    expect(planWikiRefresh("wiki.updated", { page_id: "p1" }, "p1")).toEqual({
      tree: true,
      page: true,
      links: true,
      comments: false,
    });
  });

  it("wiki.deleted on index view only refreshes tree", () => {
    expect(planWikiRefresh("wiki.deleted", { page_id: "p1" }, undefined)).toEqual({
      tree: true,
      page: false,
      links: false,
      comments: false,
    });
  });

  it("wiki.comment_* refreshes comments only when active page matches", () => {
    expect(planWikiRefresh("wiki.comment_created", { page_id: "p1" }, "p1")).toEqual({
      tree: false,
      page: false,
      links: false,
      comments: true,
    });
    expect(planWikiRefresh("wiki.comment_created", { page_id: "p2" }, "p1")).toEqual({
      tree: false,
      page: false,
      links: false,
      comments: false,
    });
  });

  it("task.* refreshes active page links only", () => {
    expect(planWikiRefresh("task.updated", { task_id: "t1" }, "p1")).toEqual({
      tree: false,
      page: false,
      links: true,
      comments: false,
    });
  });
});

describe("decidePageSyncAction", () => {
  it("replaces page immediately when not editing", () => {
    expect(decidePageSyncAction(false, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")).toBe("replace");
  });

  it("signals conflict instead of overwriting draft when editing and remote changed", () => {
    expect(decidePageSyncAction(true, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")).toBe("conflict");
  });

  it("returns noop when editing and remote version is unchanged", () => {
    expect(decidePageSyncAction(true, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe("noop");
  });
});
