import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "./draftStorage";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  },
  configurable: true,
});

describe("draftStorage", () => {
  beforeEach(() => {
    store.clear();
  });

  it("saves, loads, and clears typed drafts", () => {
    expect(loadDraft("wiki:p1:w1")).toBeNull();
    saveDraft("wiki:p1:w1", { title: "초안", content: "본문" }, "2026-11-22T00:00:00Z");

    const loaded = loadDraft<{ title: string; content: string }>("wiki:p1:w1");
    expect(loaded?.data).toEqual({ title: "초안", content: "본문" });
    expect(loaded?.baseUpdatedAt).toBe("2026-11-22T00:00:00Z");
    expect(typeof loaded?.savedAt).toBe("number");

    clearDraft("wiki:p1:w1");
    expect(loadDraft("wiki:p1:w1")).toBeNull();
  });

  it("returns null on corrupted JSON", () => {
    store.set("mw:draft:bad", "{not-json");
    expect(loadDraft("bad")).toBeNull();
  });
});
