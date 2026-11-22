import { useEffect, useState } from "react";
import { forceReloadApp, useVersionCheck } from "../lib/versionCheck";
import { CloseIcon, RefreshIcon } from "./icons";

/**
 * 새 앱 버전 배포를 자동 감지해 강제 새로고침을 안내하는 모달 팝업 (취소 가능).
 * - 취소('나중에' / ESC / 배경 클릭)한 동일 버전은 재팝업하지 않으며, 더 높은 버전이 배포되면 다시 안내한다.
 */
export function VersionUpdatePrompt() {
  const { currentVersion, availableVersion, open, dismiss } = useVersionCheck();
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !reloading) {
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, reloading, dismiss]);

  if (!open || !availableVersion) return null;

  const handleReload = async () => {
    if (reloading) return;
    setReloading(true);
    await forceReloadApp();
  };

  return (
    <div
      className="modal-backdrop version-backdrop"
      onClick={() => !reloading && dismiss()}
      role="presentation"
    >
      <div
        className="card version-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-update-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="version-modal-head">
          <span className="version-icon-badge" aria-hidden="true">
            <RefreshIcon size={16} className={reloading ? "is-spinning" : ""} />
          </span>
          <div className="version-head-text">
            <h3 id="version-update-title">새 버전이 출시되었습니다</h3>
            <div className="version-diff">
              <span className="version-ver-pill">v{currentVersion}</span>
              <span className="muted" aria-hidden="true">→</span>
              <span className="version-ver-pill is-new">v{availableVersion}</span>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={dismiss}
            disabled={reloading}
            aria-label="닫기"
            title="나중에 업데이트 (Esc)"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <p className="version-modal-desc">
          최신 기능과 오류 수정을 적용하려면 웹 페이지를 강제 새로고침해 주세요.
          작성 중인 내용이 있다면 먼저 저장한 뒤 새로고침할 수 있습니다.
        </p>

        <div className="quick-foot">
          <button type="button" className="btn btn-ghost" onClick={dismiss} disabled={reloading}>
            나중에
          </button>
          <button type="button" className="btn btn-accent" onClick={handleReload} disabled={reloading} autoFocus>
            <RefreshIcon size={12} className={reloading ? "is-spinning" : ""} />
            {reloading ? "새 버전 불러오는 중…" : "지금 강제 새로고침"}
          </button>
        </div>
      </div>
    </div>
  );
}
