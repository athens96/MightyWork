import { useCallback, useEffect, useRef, useState } from "react";
import { APP_VERSION } from "./version";

export const VERSION_AVAILABLE_EVENT = "mightywork:version-available";
export const OPEN_VERSION_MODAL_EVENT = "mightywork:open-version-modal";

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** SemVer 문자열 파싱 (앞의 'v', '+build' 메타데이터, '-prerelease' 지원) */
export function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, "").split("+")[0];
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** SemVer 2.0.0 비교: a > b → 1, a < b → -1, 같음 → 0, 파싱 실패 → null */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // 정식 릴리즈 > 프리릴리즈
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) > Number(bi) ? 1 : -1;
    if (aNum) return -1;
    if (bNum) return 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

/** 원격 버전이 현재 실행 중인 클라이언트 버전보다 높으면 true */
export function isNewerVersion(remote: string, current: string): boolean {
  const cmp = compareSemver(remote, current);
  return cmp !== null && cmp > 0;
}

async function readVersionFromUrl(url: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const res = await fetcher(url, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data?.version === "string" && data.version.trim() ? data.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 배포된 최신 앱 버전을 조회한다.
 * 정적 빌드 자산(/version.json)을 우선 확인해 새 클라이언트 번들이 실제로 올라간 시점에 안내하며,
 * 정적 파일이 없는 환경에서는 /api/version 으로 폴백한다.
 */
export async function fetchRemoteVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  const bust = `_=${Date.now()}`;
  const staticVer = await readVersionFromUrl(`/version.json?${bust}`, fetcher);
  if (staticVer) return staticVer;
  return readVersionFromUrl(`/api/version?${bust}`, fetcher);
}

/** 브라우저 캐시·Cache Storage 를 비우고 문서를 재검증한 뒤 강제 새로고침 */
export async function forceReloadApp(): Promise<void> {
  try {
    if ("caches" in window && window.caches) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((k) => window.caches.delete(k)));
    }
  } catch {
    // 일부 프라이빗 브라우저에서는 Cache Storage 접근이 제한될 수 있음
  }
  try {
    if ("serviceWorker" in navigator && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
    }
  } catch {
    // ignore
  }
  try {
    await fetch("/", { cache: "reload" });
  } catch {
    // 네트워크 오류가 나더라도 reload 시도
  }
  window.location.reload();
}

export interface VersionCheckOptions {
  currentVersion?: string;
  intervalMs?: number;
  minGapMs?: number;
  fetcher?: typeof fetch;
}

/**
 * 주기적 폴링 + 탭 복귀(visibilitychange/focus) + 네트워크 복귀(online) 시
 * 서버의 버전 상승을 감지해 강제 새로고침 팝업 상태를 관리한다.
 */
export function useVersionCheck({
  currentVersion = APP_VERSION,
  intervalMs = 60_000,
  minGapMs = 10_000,
  fetcher = fetch,
}: VersionCheckOptions = {}) {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const dismissedRef = useRef<string | null>(null);
  const lastCheckAtRef = useRef(0);
  const inFlightRef = useRef(false);

  const checkNow = useCallback(
    async (force = false) => {
      if (inFlightRef.current) return;
      if (!force && typeof navigator !== "undefined" && navigator.onLine === false) return;
      const now = Date.now();
      if (!force && now - lastCheckAtRef.current < minGapMs) return;

      inFlightRef.current = true;
      lastCheckAtRef.current = now;
      try {
        const remote = await fetchRemoteVersion(fetcher);
        if (!remote || !isNewerVersion(remote, currentVersion)) return;

        setAvailableVersion(remote);
        window.dispatchEvent(new CustomEvent<{ version: string }>(VERSION_AVAILABLE_EVENT, { detail: { version: remote } }));

        // 사용자가 이미 취소한 동일 버전은 재팝업하지 않되, 더 높은 버전이 나오면 다시 팝업
        const dismissed = dismissedRef.current;
        if (!dismissed || isNewerVersion(remote, dismissed)) {
          setOpen(true);
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [currentVersion, fetcher, minGapMs],
  );

  const dismiss = useCallback(() => {
    if (availableVersion) {
      dismissedRef.current = availableVersion;
    }
    setOpen(false);
  }, [availableVersion]);

  const reopen = useCallback(() => {
    if (availableVersion) setOpen(true);
  }, [availableVersion]);

  useEffect(() => {
    void checkNow(true);

    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkNow(false);
    }, intervalMs);

    const onWake = () => {
      if (document.visibilityState === "visible") void checkNow(false);
    };
    const onOnline = () => void checkNow(false);
    const onOpenReq = () => setOpen(true);

    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onOnline);
    window.addEventListener(OPEN_VERSION_MODAL_EVENT, onOpenReq);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onOnline);
      window.removeEventListener(OPEN_VERSION_MODAL_EVENT, onOpenReq);
    };
  }, [checkNow, intervalMs]);

  return { currentVersion, availableVersion, open, dismiss, reopen, checkNow };
}
