import { describe, expect, it } from "vitest";
import { dueState, formatDate, todayYmd } from "./time";

function offsetYmd(days: number): string {
  const d = new Date(todayYmd());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("time helpers", () => {
  it("formats dates with year omitted only for current year", () => {
    const year = new Date().getFullYear();
    expect(formatDate(`${year}-05-09`)).toBe("5월 9일");
    expect(formatDate(`${year - 1}-12-25`)).toBe(`${year - 1}년 12월 25일`);
  });

  it("classifies due date urgency and ignores completed tasks", () => {
    expect(dueState(null, false)).toBeNull();
    expect(dueState(offsetYmd(-3), true)).toBeNull();
    expect(dueState(offsetYmd(-1), false)).toBe("overdue");
    expect(dueState(offsetYmd(0), false)).toBe("soon");
    expect(dueState(offsetYmd(2), false)).toBe("soon");
    expect(dueState(offsetYmd(5), false)).toBe("ok");
  });
});
