import { useEffect, useState } from "react";

export type BookmarkKind = "task" | "wiki";

export interface NavBookmark {
  kind: BookmarkKind;
  id: string;
  projectId: string;
  projectKey: string;
  label: string; // 예: MW-21 (일감) 또는 MW (위키)
  title: string;
  path: string;
  at: number;
}

export type NavBookmarkInput = Omit<NavBookmark, "at">;

const PINS_KEY = "mw:pins";
const RECENTS_KEY = "mw:recents";
const MAX_PINS = 12;
const MAX_RECENTS = 8;
export const BOOKMARKS_EVENT = "mightywork:nav-bookmarks";

function readList(key: string): NavBookmark[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is NavBookmark =>
        Boolean(x) &&
        (x.kind === "task" || x.kind === "wiki") &&
        typeof x.id === "string" &&
        typeof x.projectId === "string" &&
        typeof x.path === "string" &&
        typeof x.title === "string",
    );
  } catch {
    return [];
  }
}

function writeList(key: string, items: NavBookmark[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // ignore storage quota errors
  }
}

function notify(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(BOOKMARKS_EVENT));
  }
}

const sameKey = (a: { kind: BookmarkKind; id: string }, b: { kind: BookmarkKind; id: string }) =>
  a.kind === b.kind && a.id === b.id;

export function getPins(): NavBookmark[] {
  return readList(PINS_KEY);
}

export function getRecents(): NavBookmark[] {
  return readList(RECENTS_KEY);
}

export function isPinned(kind: BookmarkKind, id: string): boolean {
  return getPins().some((p) => p.kind === kind && p.id === id);
}

export function togglePin(item: NavBookmarkInput): boolean {
  const pins = getPins();
  const exists = pins.some((p) => sameKey(p, item));
  const next = exists
    ? pins.filter((p) => !sameKey(p, item))
    : [{ ...item, at: Date.now() }, ...pins].slice(0, MAX_PINS);
  writeList(PINS_KEY, next);
  notify();
  return !exists;
}

export function removePin(kind: BookmarkKind, id: string): void {
  const pins = getPins();
  const next = pins.filter((p) => !(p.kind === kind && p.id === id));
  if (next.length !== pins.length) {
    writeList(PINS_KEY, next);
    notify();
  }
}

export function recordRecent(item: NavBookmarkInput): void {
  const now = Date.now();
  const recents = getRecents().filter((r) => !sameKey(r, item));
  writeList(RECENTS_KEY, [{ ...item, at: now }, ...recents].slice(0, MAX_RECENTS));

  // 고정된 항목이 제목·경로가 바뀌었으면 같이 동기화
  const pins = getPins();
  const idx = pins.findIndex((p) => sameKey(p, item));
  if (idx >= 0) {
    const cur = pins[idx];
    if (cur.title !== item.title || cur.label !== item.label || cur.path !== item.path || cur.projectKey !== item.projectKey) {
      const updated = [...pins];
      updated[idx] = { ...cur, ...item };
      writeList(PINS_KEY, updated);
    }
  }
  notify();
}

export function removeBookmark(kind: BookmarkKind, id: string): void {
  const pins = getPins();
  const recents = getRecents();
  const nextPins = pins.filter((p) => !(p.kind === kind && p.id === id));
  const nextRecents = recents.filter((r) => !(r.kind === kind && r.id === id));
  if (nextPins.length !== pins.length) writeList(PINS_KEY, nextPins);
  if (nextRecents.length !== recents.length) writeList(RECENTS_KEY, nextRecents);
  if (nextPins.length !== pins.length || nextRecents.length !== recents.length) notify();
}

export function useNavBookmarks(): { pins: NavBookmark[]; recents: NavBookmark[] } {
  const [state, setState] = useState<{ pins: NavBookmark[]; recents: NavBookmark[] }>(() => ({
    pins: getPins(),
    recents: getRecents(),
  }));

  useEffect(() => {
    const sync = () => setState({ pins: getPins(), recents: getRecents() });
    window.addEventListener(BOOKMARKS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(BOOKMARKS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return state;
}
