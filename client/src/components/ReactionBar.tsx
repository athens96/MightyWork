import { useState } from "react";
import type { User } from "../types";

export const REACTION_EMOJIS = ["👍", "👀", "✅", "❤️", "🚀"] as const;

interface Props {
  reactions?: Record<string, string[]>;
  meId: string | undefined;
  users: User[];
  onToggle: (emoji: string) => void | Promise<void>;
}

/** 경량 댓글 이모지 리액션 바 (추가 패키지 없음) */
export function ReactionBar({ reactions = {}, meId, users, onToggle }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const active = Object.entries(reactions).filter(([, ids]) => ids.length > 0);
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name || users.find((u) => u.id === id)?.email || "사용자";

  return (
    <div className="reaction-bar">
      {active.map(([emoji, ids]) => {
        const mine = Boolean(meId && ids.includes(meId));
        return (
          <button
            key={emoji}
            type="button"
            className={`reaction-chip ${mine ? "is-mine" : ""}`}
            aria-pressed={mine}
            title={ids.map(nameOf).join(", ")}
            onClick={() => onToggle(emoji)}
          >
            <span>{emoji}</span>
            <span className="mono">{ids.length}</span>
          </button>
        );
      })}
      <div className="menu-anchor">
        <button
          type="button"
          className="reaction-add-btn"
          title="반응 추가"
          aria-label="반응 추가"
          onClick={() => setPickerOpen((o) => !o)}
        >
          +☺
        </button>
        {pickerOpen && (
          <div className="popover reaction-picker" role="menu">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="reaction-pick-btn"
                onClick={() => {
                  setPickerOpen(false);
                  onToggle(emoji);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
