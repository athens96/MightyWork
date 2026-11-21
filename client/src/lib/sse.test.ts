import { describe, expect, it } from "vitest";
import { parseSSEBuffer } from "./sse";

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
