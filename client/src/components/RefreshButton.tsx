import { RefreshIcon } from "./icons";
import { formatClockTime } from "../lib/useAutoRefresh";

interface Props {
  refreshing: boolean;
  lastUpdated: Date | null;
  onClick: () => void;
  intervalSec?: number;
  compact?: boolean;
  shortcut?: boolean;
}

/** 수동 새로고침 버튼 (회전 애니메이션 + 마지막 갱신 시각 + 자동 갱신 주기 안내) */
export function RefreshButton({
  refreshing,
  lastUpdated,
  onClick,
  intervalSec = 30,
  compact = false,
  shortcut = false,
}: Props) {
  const clock = lastUpdated ? formatClockTime(lastUpdated) : "";
  const titleParts = [
    shortcut ? "새로고침 (단축키 R)" : "새로고침",
    clock ? `마지막 갱신 ${clock}` : "",
    intervalSec > 0 ? `${intervalSec}초마다 자동 갱신` : "",
  ].filter(Boolean);
  const title = titleParts.join(" · ");

  if (compact) {
    return (
      <button
        type="button"
        className="icon-btn refresh-btn"
        onClick={onClick}
        disabled={refreshing}
        title={title}
        aria-label="새로고침"
      >
        <RefreshIcon size={13} className={refreshing ? "is-spinning" : undefined} />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-sm refresh-btn"
      onClick={onClick}
      disabled={refreshing}
      title={title}
      aria-label="새로고침"
    >
      <RefreshIcon size={12} className={refreshing ? "is-spinning" : undefined} />
      <span>{refreshing ? "갱신 중…" : "새로고침"}</span>
      {clock && <span className="refresh-clock">{clock}</span>}
    </button>
  );
}
