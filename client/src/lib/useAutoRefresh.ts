import { useCallback, useEffect, useRef, useState } from "react";

export const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

export function formatClockTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function shouldRefreshOnFocus(lastUpdated: Date | null, nowMs: number, minGapMs = 10_000): boolean {
  if (!lastUpdated) return true;
  return nowMs - lastUpdated.getTime() >= minGapMs;
}

interface Options {
  /** 주기적 자동 갱신 간격 (기본 30초, 0 이면 주기 비활성화) */
  intervalMs?: number;
  /** 자동 갱신 활성화 여부 */
  enabled?: boolean;
  /** 탭 복귀·온라인 복구 시 자동 갱신 여부 (기본 true) */
  refreshOnFocus?: boolean;
  /** 단축키 R(입력 중이 아닐 때)로 수동 새로고침 지원 여부 */
  shortcutKey?: boolean;
}

/**
 * 수동 새로고침 + 주기적 백그라운드 자동 새로고침 + 탭 복귀 시 동기화를 제공하는 공용 훅.
 * 동시 중복 요청을 방지하며, 백그라운드 탭에서는 타이머를 건너뛰어 불필요한 트래픽을 줄인다.
 */
export function useAutoRefresh(onRefresh: () => Promise<unknown> | void, options: Options = {}) {
  const {
    intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    enabled = true,
    refreshOnFocus = true,
    shortcutKey = false,
  } = options;

  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() => new Date());
  const fnRef = useRef(onRefresh);
  fnRef.current = onRefresh;
  const lastRef = useRef<Date | null>(lastUpdated);
  lastRef.current = lastUpdated;
  const inFlightRef = useRef(false);

  const markUpdated = useCallback(() => {
    const now = new Date();
    lastRef.current = now;
    setLastUpdated(now);
  }, []);

  const run = useCallback(async (showSpinner: boolean) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (showSpinner) setRefreshing(true);
    try {
      await fnRef.current();
      const now = new Date();
      lastRef.current = now;
      setLastUpdated(now);
    } catch {
      // 일시적 네트워크 오류 시 기존 화면 유지
    } finally {
      inFlightRef.current = false;
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => run(true), [run]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) {
        void run(false);
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, run]);

  useEffect(() => {
    if (!enabled || !refreshOnFocus) return;
    const triggerIfStale = () => {
      if (document.visibilityState === "visible" && shouldRefreshOnFocus(lastRef.current, Date.now())) {
        void run(false);
      }
    };
    const onOnline = () => void run(false);
    document.addEventListener("visibilitychange", triggerIfStale);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", triggerIfStale);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, refreshOnFocus, run]);

  useEffect(() => {
    if (!enabled || !shortcutKey) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']");
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        void run(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, shortcutKey, run]);

  return { refreshing, lastUpdated, refresh, markUpdated };
}
