/** 위키 체크리스트 항목 및 선택 텍스트에 새로 만든 일감 키(MW-12)를 안전하게 삽입하는 순수 유틸. */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 문자열 안에 이미 해당 프로젝트의 일감 키(예: MW-12)가 포함되어 있는지 확인 */
export function hasTaskKey(text: string, projectKey: string): boolean {
  if (!projectKey) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(projectKey)}-\\d+(?![A-Za-z0-9])`, "i").test(text);
}

/**
 * 마크다운 본문에서 펜스드 코드 블록 바깥의 체크리스트 줄(`- [ ] ...`)을 찾아 ` (KEY-n)` 을 덧붙인다.
 */
export function injectTaskKeyIntoChecklist(content: string, itemText: string, taskKey: string): string {
  const target = stripInlineMarkdown(itemText);
  if (!target) return content;

  const lines = content.split("\n");
  let inFence = false;
  let replaced = false;

  const next = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || replaced) return line;
    const m = /^(\s*[-*+]\s+\[[ xX]\]\s+)(.+)$/.exec(line);
    if (!m) return line;
    const body = m[2];
    if (stripInlineMarkdown(body) === target) {
      replaced = true;
      if (body.includes(taskKey)) return line;
      return `${m[1]}${body.trimEnd()} (${taskKey})`;
    }
    return line;
  });

  if (replaced) return next.join("\n");
  return injectTaskKeyIntoSelection(content, itemText, taskKey);
}

/**
 * 마크다운 본문에서 코드 블록 바깥의 선택 텍스트 뒤에 ` (KEY-n)` 을 덧붙인다.
 * 마크다운 문법 때문에 원문 일치 검색이 실패하면 문서 하단에 참조 줄을 안전하게 추가한다.
 */
export function injectTaskKeyIntoSelection(content: string, selectedText: string, taskKey: string): string {
  const needle = selectedText.trim();
  if (!needle) return content;

  const lines = content.split("\n");
  let inFence = false;
  let replaced = false;

  const candidates = [needle, needle.split("\n")[0].trim()].filter(Boolean);

  for (const cand of candidates) {
    inFence = false;
    const updated = lines.map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || replaced) return line;
      const idx = line.indexOf(cand);
      if (idx !== -1) {
        replaced = true;
        const end = idx + cand.length;
        return `${line.slice(0, end)} (${taskKey})${line.slice(end)}`;
      }
      return line;
    });
    if (replaced) return updated.join("\n");
  }

  return `${content.trimEnd()}\n\n- 관련 일감: ${taskKey}`;
}
