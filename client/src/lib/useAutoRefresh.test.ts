import { describe, expect, it } from "vitest";
import { formatClockTime, shouldRefreshOnFocus } from "./useAutoRefresh";

describe("useAutoRefresh helpers", () => {
  it("formats HH:MM:SS zero-padded clock time", () => {
    const d = new Date(2026, 10, 22, 9, 5, 3);
    expect(formatClockTime(d)).toBe("09:05:03");
  });

  it("refreshes on focus only when stale beyond threshold", () => {
    const base = new Date(2026, 10, 22, 11, 0, 0);
    expect(shouldRefreshOnFocus(null, base.getTime())).toBe(true);
    expect(shouldRefreshOnFocus(base, base.getTime() + 4_000, 10_000)).toBe(false);
    expect(shouldRefreshOnFocus(base, base.getTime() + 12_000, 10_000)).toBe(true);
  });
});
