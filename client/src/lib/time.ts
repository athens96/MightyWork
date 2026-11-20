const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

/** "3분 전", "어제", "2주 전" 형태 */
export function timeAgo(iso: string): string {
  const diffSec = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, sec] of units) {
    if (Math.abs(diffSec) >= sec) return rtf.format(Math.round(diffSec / sec), unit);
  }
  return "방금 전";
}

/** "2026-11-30" → "11월 30일" (올해가 아니면 연도 포함) */
export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return y === new Date().getFullYear() ? `${m}월 ${d}일` : `${y}년 ${m}월 ${d}일`;
}

/** 오늘(로컬) 기준 YYYY-MM-DD */
export function todayYmd(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/** 종료일 상태: 지남(overdue) / 2일 이내(soon) / 여유(ok) */
export function dueState(due: string | null, done: boolean): "overdue" | "soon" | "ok" | null {
  if (!due || done) return null;
  const days = (new Date(due).getTime() - new Date(todayYmd()).getTime()) / 86400000;
  return days < 0 ? "overdue" : days <= 2 ? "soon" : "ok";
}
