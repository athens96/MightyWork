import { useState, type KeyboardEvent } from "react";
import { PlusIcon, TrashIcon } from "../../components/icons";
import type { ChecklistItem } from "../../types";

interface Props {
  items: ChecklistItem[];
  readOnly?: boolean;
  onChange: (items: ChecklistItem[]) => void;
  onPromote?: (item: ChecklistItem, index: number) => void | Promise<void>;
}

/** 할 일 체크리스트 — 순서 변경(↑/↓·드래그앤드롭) 및 하위 일감 원클릭 승격 지원 */
export function TaskChecklist({ items, readOnly = false, onChange, onPromote }: Props) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
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

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
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
          <li
            key={item.id ?? index}
            className={`${item.done ? "done" : ""} ${dragIdx === index ? "is-dragging" : ""} ${overIdx === index && dragIdx !== index ? "is-drop-target" : ""}`}
            draggable={!readOnly && editing?.index !== index}
            onDragStart={(e) => {
              setDragIdx(index);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(index));
            }}
            onDragOver={(e) => {
              if (readOnly || dragIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overIdx !== index) setOverIdx(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null) reorder(dragIdx, index);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
          >
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
            {!readOnly && editing?.index !== index && (
              <span className="check-actions">
                {items.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="check-mini-btn"
                      disabled={index === 0}
                      onClick={() => reorder(index, index - 1)}
                      title="위로 이동"
                      aria-label="위로 이동"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="check-mini-btn"
                      disabled={index === items.length - 1}
                      onClick={() => reorder(index, index + 1)}
                      title="아래로 이동"
                      aria-label="아래로 이동"
                    >
                      ↓
                    </button>
                  </>
                )}
                {onPromote && (
                  <button
                    type="button"
                    className="check-mini-btn check-promote-btn"
                    onClick={() => onPromote(item, index)}
                    title="이 할 일을 하위 일감으로 승격"
                  >
                    ↳ 하위 일감
                  </button>
                )}
                <button className="icon-btn danger" onClick={() => onChange(items.filter((_, i) => i !== index))} title="삭제">
                  <TrashIcon size={12} />
                </button>
              </span>
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
