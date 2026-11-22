import type { RefObject } from "react";
import { applyMarkdownFormat, type MarkdownFormatAction } from "../lib/markdownHelpers";

interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}

const BUTTONS: { action: MarkdownFormatAction; label: string; title: string }[] = [
  { action: "h2", label: "H2", title: "소제목 (##)" },
  { action: "bold", label: "B", title: "굵게 (**)" },
  { action: "italic", label: "I", title: "기울임 (*)" },
  { action: "code", label: "<>", title: "인라인 코드 (`)" },
  { action: "codeblock", label: "코드블록", title: "코드 블록 (```)" },
  { action: "checklist", label: "체크", title: "체크리스트 (- [ ])" },
  { action: "table", label: "표", title: "마크다운 표 삽입" },
  { action: "callout", label: "콜아웃", title: "콜아웃 블록 (> [!NOTE])" },
  { action: "link", label: "링크", title: "링크 ([텍스트](url))" },
  { action: "hr", label: "구분선", title: "구분선 (---)" },
];

/** 경량 마크다운 서식 삽입 툴바 (외부 WYSIWYG 없이 textarea 선택 영역에 직접 적용) */
export function MarkdownToolbar({ textareaRef, value, onChange }: Props) {
  const apply = (action: MarkdownFormatAction) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const { next, selStart, selEnd } = applyMarkdownFormat(value, start, end, action);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  };

  return (
    <div className="md-toolbar" role="toolbar" aria-label="마크다운 서식 도구">
      {BUTTONS.map((b) => (
        <button
          key={b.action}
          type="button"
          className={`md-tool-btn ${b.action === "bold" ? "is-bold" : b.action === "italic" ? "is-italic" : ""}`}
          title={b.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(b.action)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
