import { useState, type KeyboardEvent } from "react";
import { PlusIcon, TrashIcon } from "../../components/icons";
import type { ChecklistItem } from "../../types";

interface Props {
  items: ChecklistItem[];
  readOnly?: boolean;
  onChange: (items: ChecklistItem[]) => void;
}

/** 할 일 체크리스트 — 변경 시 전체 목록을 저장 */
export function TaskChecklist({ items, readOnly = false, onChange }: Props) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const done = items.filter((i) => i.done).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;

  const add = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !draft.trim()) return;
    onChange([...items, { text: draft.trim(), done: false }]);
    setDraft("");
  };

  const commitEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text && text !== items[editing.index].text) onChange(items.map((it, i) => (i === editing.index ? { ...it, text } : it)));
    setEditing(null);
  };

  return (
    <section className="detail-section">
      <header className="section-head">
        <h3>할 일</h3>
        {items.length > 0 && (
          <>
            <span className="mono muted">
              {done}/{items.length}
            </span>
            <div className="progress" aria-label={`${percent}% 완료`}>
              <div style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
      </header>

      <ul className="checklist">
        {items.map((item, index) => (
          <li key={item.id ?? index} className={item.done ? "done" : ""}>
            <input
              type="checkbox"
              checked={item.done}
              disabled={readOnly}
              onChange={() => onChange(items.map((it, i) => (i === index ? { ...it, done: !it.done } : it)))}
            />
            {editing?.index === index ? (
              <input
                className="check-edit"
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ index, text: e.target.value })}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) commitEdit();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span className="check-text" onClick={() => !readOnly && setEditing({ index, text: item.text })}>
                {item.text}
              </span>
            )}
            {!readOnly && (
              <button className="icon-btn danger" onClick={() => onChange(items.filter((_, i) => i !== index))} title="삭제">
                <TrashIcon size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {readOnly && items.length === 0 && <p className="muted">할 일 없음</p>}
      {!readOnly && (
      <label className="check-add">
        <PlusIcon size={11} />
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={add} placeholder="할 일 추가 후 Enter" />
      </label>
      )}
    </section>
  );
}
