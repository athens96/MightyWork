export interface HeadingItem {
  level: 1 | 2 | 3;
  text: string;
  id: string;
}

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export interface CalloutMeta {
  kind: CalloutKind;
  label: string;
  tone: string;
}

export const CALLOUT_META: Record<CalloutKind, CalloutMeta> = {
  note: { kind: "note", label: "참고", tone: "tone-run" },
  tip: { kind: "tip", label: "팁", tone: "tone-done" },
  important: { kind: "important", label: "중요", tone: "tone-agent" },
  warning: { kind: "warning", label: "주의", tone: "tone-wait" },
  caution: { kind: "caution", label: "경고", tone: "tone-err" },
};

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/i;
const TOGGLE_RE = /^\[!TOGGLE(\+)?\](?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/i;

/** 콜아웃 마커([!NOTE] 등) 파싱 */
export function parseCalloutHeader(text: string): { meta: CalloutMeta; customTitle: string; rest: string } | null {
  const m = CALLOUT_RE.exec(text.trimStart());
  if (!m) return null;
  const kind = m[1].toLowerCase() as CalloutKind;
  return {
    meta: CALLOUT_META[kind],
    customTitle: (m[2] ?? "").trim(),
    rest: m[3] ?? "",
  };
}

/** 접이식 토글 블록([!TOGGLE] / [!TOGGLE+]) 파싱 */
export function parseToggleHeader(text: string): { title: string; open: boolean; rest: string } | null {
  const m = TOGGLE_RE.exec(text.trimStart());
  if (!m) return null;
  return {
    open: m[1] === "+",
    title: (m[2] ?? "").trim() || "세부 내용 보기",
    rest: m[3] ?? "",
  };
}

/** 마크다운 인라인 문법 제거 후 순수 헤딩 텍스트 추출 */
export function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/** 한국어·영문·숫자를 보존하는 안정적인 헤딩 앵커 슬러그 생성 */
export function slugifyHeading(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? `h-${base}` : `h-${base}-${count + 1}`;
}

/** 코드 펜스를 제외하고 H1~H3 헤딩 목록을 추출해 자동 목차(TOC) 데이터 생성 */
export function extractHeadings(markdown: string): HeadingItem[] {
  const lines = markdown.split(/\r?\n/);
  const seen = new Map<string, number>();
  const out: HeadingItem[] = [];
  let inFence = false;
  let fenceChar = "";

  for (const line of lines) {
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[2][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;

    const hm = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!hm) continue;
    const level = hm[1].length as 1 | 2 | 3;
    const text = stripInlineMarkdown(hm[2]);
    if (!text) continue;
    out.push({ level, text, id: slugifyHeading(text, seen) });
  }
  return out;
}

export type MarkdownFormatAction =
  | "h2"
  | "bold"
  | "italic"
  | "code"
  | "codeblock"
  | "checklist"
  | "table"
  | "callout"
  | "toggle"
  | "link"
  | "hr";

/** 마크다운 에디터 선택 영역에 서식을 적용하고 새 커서 범위를 반환 */
export function applyMarkdownFormat(
  value: string,
  start: number,
  end: number,
  action: MarkdownFormatAction,
): { next: string; selStart: number; selEnd: number } {
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  const needLeadingNl = before.length > 0 && !before.endsWith("\n") ? "\n" : "";

  const wrap = (prefix: string, suffix: string, placeholder: string) => {
    const inner = selected || placeholder;
    const next = before + prefix + inner + suffix + after;
    const s = before.length + prefix.length;
    return { next, selStart: s, selEnd: s + inner.length };
  };

  switch (action) {
    case "bold":
      return wrap("**", "**", "굵게");
    case "italic":
      return wrap("*", "*", "기울임");
    case "code":
      return wrap("`", "`", "code");
    case "link":
      return wrap("[", "](https://)", selected ? selected : "링크 텍스트");
    case "h2": {
      const inner = selected || "소제목";
      const prefix = `${needLeadingNl}## `;
      const next = before + prefix + inner + after;
      const s = before.length + prefix.length;
      return { next, selStart: s, selEnd: s + inner.length };
    }
    case "checklist": {
      const lines = (selected || "할 일 항목").split("\n").map((l) => (l.startsWith("- [ ] ") ? l : `- [ ] ${l}`));
      const block = `${needLeadingNl}${lines.join("\n")}`;
      const next = before + block + after;
      const s = before.length + needLeadingNl.length + 6;
      return { next, selStart: s, selEnd: before.length + block.length };
    }
    case "codeblock": {
      const inner = selected || "// 코드 입력";
      const prefix = `${needLeadingNl}\`\`\`\n`;
      const suffix = "\n```";
      const next = before + prefix + inner + suffix + after;
      const s = before.length + prefix.length;
      return { next, selStart: s, selEnd: s + inner.length };
    }
    case "callout": {
      const inner = selected || "중요한 참고 내용을 입력하세요.";
      const prefix = `${needLeadingNl}> [!NOTE]\n> `;
      const body = inner.split("\n").join("\n> ");
      const next = before + prefix + body + after;
      const s = before.length + prefix.length;
      return { next, selStart: s, selEnd: s + body.length };
    }
    case "toggle": {
      const inner = selected || "세부 내용을 입력하세요.";
      const prefix = `${needLeadingNl}> [!TOGGLE] 자세히 보기\n> `;
      const body = inner.split("\n").join("\n> ");
      const next = before + prefix + body + after;
      const s = before.length + prefix.length;
      return { next, selStart: s, selEnd: s + body.length };
    }
    case "table": {
      const tpl = `${needLeadingNl}| 항목 | 설명 | 비고 |\n| --- | --- | --- |\n| 내용 | 설명 | - |\n`;
      const next = before + tpl + after;
      const pos = before.length + tpl.length;
      return { next, selStart: pos, selEnd: pos };
    }
    case "hr": {
      const tpl = `${needLeadingNl}\n---\n\n`;
      const next = before + tpl + after;
      const pos = before.length + tpl.length;
      return { next, selStart: pos, selEnd: pos };
    }
  }
}
