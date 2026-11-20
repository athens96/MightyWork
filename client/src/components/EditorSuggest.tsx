import { useEffect, useState, type KeyboardEvent } from "react";
import { applySuggest, detectSuggest, filterSuggestions, type SuggestItem, type SuggestMatch } from "../lib/editorSuggest";
import type { User, WikiPageSummary } from "../types";

interface Props {
  value: string;
  cursor: number;
  pages?: WikiPageSummary[];
  users?: User[];
  onApply: (nextValue: string, nextCursor: number) => void;
}

export function useEditorSuggest(value: string, cursor: number, pages: WikiPageSummary[] = [], users: User[] = []) {
  const match: SuggestMatch | null = detectSuggest(value, cursor);
  const items: SuggestItem[] = filterSuggestions(match, pages, users);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [match?.kind, match?.query, items.length]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, onApply: (v: string, c: number) => void): boolean => {
    if (!match || items.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (i + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const picked = items[index] ?? items[0];
      const next = applySuggest(value, match, picked.insert);
      onApply(next.value, next.cursor);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setIndex(-1);
      return true;
    }
    return false;
  };

  return { match, items: index === -1 ? [] : items, index, setIndex, handleKeyDown };
}

export function EditorSuggestBar({
  match,
  items,
  index,
  value,
  onPick,
}: {
  match: SuggestMatch | null;
  items: SuggestItem[];
  index: number;
  value: string;
  onPick: (nextValue: string, nextCursor: number) => void;
}) {
  if (!match || items.length === 0) return null;
  return (
    <div className="suggest-bar" role="listbox" aria-label={match.kind === "wiki" ? "위키 링크 자동완성" : "멘션 자동완성"}>
      <span className="suggest-kind">{match.kind === "wiki" ? "[[ 위키" : "@ 멘션"}</span>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`suggest-item ${i === index ? "active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            const next = applySuggest(value, match, item.insert);
            onPick(next.value, next.cursor);
          }}
        >
          <strong>{item.label}</strong>
          {item.sub && <span className="muted">{item.sub}</span>}
        </button>
      ))}
    </div>
  );
}

export type { Props as EditorSuggestProps };
