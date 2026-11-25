import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSSEBuffer, subscribeSSE } from "./sse";

describe("parseSSEBuffer", () => {
  it("parses complete frames, ignores comments, and preserves trailing remainder", () => {
    const chunk = [
      ": keepalive",
      "",
      "id: 7",
      "event: task.updated",
      'data: {"task_id":"t1","stage":"review"}',
      "",
      "id: 8",
      "event: comment.created",
      'data: {"task_id":"t1"',
    ].join("\n");

    const first = parseSSEBuffer(chunk);
    expect(first.messages).toEqual([
      { id: "7", event: "task.updated", data: { task_id: "t1", stage: "review" } },
    ]);
    expect(first.rest).toContain("id: 8");

    const second = parseSSEBuffer(first.rest + ',"comment_id":"c1"}\n\n');
    expect(second.messages).toEqual([
      { id: "8", event: "comment.created", data: { task_id: "t1", comment_id: "c1" } },
    ]);
    expect(second.rest).toBe("");
  });
});

describe("subscribeSSE hidden-tab pause", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defers connecting when started in a hidden tab and connects once visible", async () => {
    const winListeners = new Map<string, Set<EventListener>>();
    const docListeners = new Map<string, Set<EventListener>>();
    let visibilityState: DocumentVisibilityState = "hidden";

    const fakeWindow = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: (k: string, fn: EventListener) => {
        if (!winListeners.has(k)) winListeners.set(k, new Set());
        winListeners.get(k)!.add(fn);
      },
      removeEventListener: (k: string, fn: EventListener) => winListeners.get(k)?.delete(fn),
      dispatchEvent: vi.fn(),
    };
    const fakeDocument = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (k: string, fn: EventListener) => {
        if (!docListeners.has(k)) docListeners.set(k, new Set());
        docListeners.get(k)!.add(fn);
      },
      removeEventListener: (k: string, fn: EventListener) => docListeners.get(k)?.delete(fn),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("fetch", fetchMock);

    const stop = subscribeSSE("/events", () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    visibilityState = "visible";
    docListeners.get("visibilitychange")?.forEach((fn) => fn(new Event("visibilitychange")));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });
});
