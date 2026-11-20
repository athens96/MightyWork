import type { User, WikiPageSummary } from "../types";

export interface SuggestMatch {
  kind: "wiki" | "mention";
  start: number;
  end: number;
  query: string;
}

export interface SuggestItem {
  id: string;
  label: string;
  sub?: string;
  insert: string;
}

/** 커서 앞 텍스트에서 열려 있는 [[위키 링크 또는 @멘션 토큰을 탐지한다. */
export function detectSuggest(text: string, cursor: number): SuggestMatch | null {
  const before = text.slice(0, cursor);
  const wikiMatch = /\[\[([^\[\]\n]*)$/.exec(before);
  if (wikiMatch) {
    return { kind: "wiki", start: cursor - wikiMatch[0].length, end: cursor, query: wikiMatch[1] };
  }
  const mentionMatch = /(?:^|[\s(])@([^\s@\[\]()]*)$/.exec(before);
  if (mentionMatch) {
    const start = cursor - mentionMatch[1].length - 1;
    return { kind: "mention", start, end: cursor, query: mentionMatch[1] };
  }
  return null;
}

/** 후보 목록 필터링 (최대 8건) */
export function filterSuggestions(match: SuggestMatch | null, pages: WikiPageSummary[], users: User[]): SuggestItem[] {
  if (!match) return [];
  const q = match.query.trim().toLowerCase();
  if (match.kind === "wiki") {
    return pages
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((p) => ({
        id: p.id,
        label: p.title,
        sub: p.aliases.length ? p.aliases.join(", ") : undefined,
        insert: `[[${p.title}]]`,
      }));
  }
  return users
    .filter((u) => !q || (u.name || "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .slice(0, 8)
    .map((u) => ({
      id: u.id,
      label: u.name || u.email,
      sub: u.email,
      insert: `@${u.email} `,
    }));
}

/** 자동완성 후보를 적용한 새 텍스트와 커서 위치 반환 */
export function applySuggest(text: string, match: SuggestMatch, insert: string): { value: string; cursor: number } {
  const after = text.slice(match.end);
  // 이미 뒤에 ]] 가 닫혀 있는 경우 중복 방지
  const trimClose = match.kind === "wiki" && after.startsWith("]]") ? after.slice(2) : after;
  const value = text.slice(0, match.start) + insert + trimClose;
  return { value, cursor: match.start + insert.length };
}
