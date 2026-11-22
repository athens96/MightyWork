import { useEffect } from "react";

export interface SavedDraft<T> {
  data: T;
  savedAt: number;
  baseUpdatedAt?: string;
}

const PREFIX = "mw:draft:";

export function loadDraft<T>(key: string): SavedDraft<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || typeof parsed.savedAt !== "number") {
      return null;
    }
    return parsed as SavedDraft<T>;
  } catch {
    return null;
  }
}

export function saveDraft<T>(key: string, data: T, baseUpdatedAt?: string): void {
  try {
    const payload: SavedDraft<T> = { data, savedAt: Date.now(), baseUpdatedAt };
    localStorage.setItem(PREFIX + key, JSON.stringify(payload));
  } catch {
    // ignore storage quota errors
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/** 미저장 편집 내용이 있을 때 브라우저 탭 닫기·새로고침 경고 */
export function useBeforeUnloadWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
