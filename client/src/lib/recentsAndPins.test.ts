import { beforeEach, describe, expect, it } from "vitest";
import { getPins, getRecents, isPinned, recordRecent, removeBookmark, togglePin } from "./recentsAndPins";

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

describe("recentsAndPins", () => {
  beforeEach(() => {
    store.clear();
  });

  it("toggles pins and enforces max 12 items", () => {
    const item = { kind: "task" as const, id: "t1", projectId: "p1", projectKey: "MW", label: "MW-1", title: "첫 일감", path: "/projects/p1/tasks/t1" };
    expect(isPinned("task", "t1")).toBe(false);
    expect(togglePin(item)).toBe(true);
    expect(isPinned("task", "t1")).toBe(true);
    expect(getPins()).toHaveLength(1);

    expect(togglePin(item)).toBe(false);
    expect(isPinned("task", "t1")).toBe(false);

    for (let i = 0; i < 15; i++) {
      togglePin({ ...item, id: `t${i}`, label: `MW-${i}`, title: `일감 ${i}`, path: `/projects/p1/tasks/t${i}` });
    }
    expect(getPins()).toHaveLength(12);
    expect(getPins()[0].id).toBe("t14");
  });

  it("records recents without duplicates, caps at 8, and syncs pinned titles", () => {
    const wiki = { kind: "wiki" as const, id: "w1", projectId: "p1", projectKey: "MW", label: "MW", title: "초기 제목", path: "/projects/p1/wiki/w1" };
    togglePin(wiki);
    recordRecent(wiki);
    recordRecent({ ...wiki, title: "수정된 제목" });

    expect(getRecents()).toHaveLength(1);
    expect(getRecents()[0].title).toBe("수정된 제목");
    expect(getPins()[0].title).toBe("수정된 제목");

    for (let i = 0; i < 10; i++) {
      recordRecent({ kind: "task", id: `x${i}`, projectId: "p1", projectKey: "MW", label: `MW-${i}`, title: `T${i}`, path: `/t/${i}` });
    }
    expect(getRecents()).toHaveLength(8);
    expect(getRecents()[0].id).toBe("x9");
  });

  it("removes item from both pins and recents on delete", () => {
    const item = { kind: "task" as const, id: "t9", projectId: "p1", projectKey: "MW", label: "MW-9", title: "삭제 예정", path: "/t/9" };
    togglePin(item);
    recordRecent(item);
    removeBookmark("task", "t9");
    expect(getPins()).toHaveLength(0);
    expect(getRecents()).toHaveLength(0);
  });
});
