import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { oauthApi } from "../../api";
import { ApiError } from "../../api/http";
import { useAuth } from "../../auth/AuthContext";
import { Avatar } from "../../components/Avatar";
import { PlugIcon } from "../../components/icons";
import type { ConsentRequest } from "../../types";

const READ = "mightywork:read";
const WRITE = "mightywork:write";

/** MCP 클라이언트(Claude·Cursor 등)가 MightyWork 에 접근하려 할 때 보이는 OAuth 동의 화면 */
export function ConsentPage() {
  const [params] = useSearchParams();
  const requestId = params.get("request") ?? "";
  const { user } = useAuth();
  const [req, setReq] = useState<ConsentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowWrite, setAllowWrite] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    oauthApi.getRequest(requestId).then(
      (r) => {
        setReq(r);
        setAllowWrite(r.requested_scopes.includes(WRITE));
      },
      (e) => setError(e instanceof ApiError ? String(e.detail) : "요청을 불러오지 못했습니다."),
    );
  }, [requestId]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const { redirect_to } = await oauthApi.decide(requestId, approve, allowWrite ? [READ, WRITE] : [READ]);
      window.location.href = redirect_to; // 클라이언트 앱으로 (code 또는 error)
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? String(e.detail) : "처리하지 못했습니다.");
    }
  };

  return (
    <div className="login">
      <div className="card consent-card">
        <div className="consent-brand">
          <img src="/mascot-256.png" alt="MightyWork" width={44} height={44} />
          <span className="consent-link">
            <PlugIcon size={14} />
          </span>
        </div>
        {error && (
          <>
            <h1 className="consent-title">연결할 수 없습니다</h1>
            <p className="error">{error}</p>
          </>
        )}
        {!error && !req && <p className="muted">불러오는 중…</p>}
        {req && (
          <>
            <h1 className="consent-title">
              <strong>{req.client_name}</strong> 이(가) MightyWork 에 연결하려고 합니다
            </h1>
            <div className="consent-meta">
              <div>
                <span className="muted">앱 식별</span>
                <span className="mono">{req.registration === "cimd" ? req.client_id : "동적 등록 앱"}</span>
              </div>
              <div>
                <span className="muted">돌아갈 주소</span>
                <span className="mono">{req.redirect_host}</span>
              </div>
              <div>
                <span className="muted">계정</span>
                <span className="consent-user">
                  <Avatar user={user} size={16} /> {user?.name} <span className="muted">{user?.email}</span>
                </span>
              </div>
            </div>
            <fieldset className="consent-scopes">
              <legend>허용할 범위</legend>
              <label>
                <input type="checkbox" checked disabled /> {req.scope_labels[READ]}
              </label>
              <label>
                <input type="checkbox" checked={allowWrite} onChange={(e) => setAllowWrite(e.target.checked)} /> {req.scope_labels[WRITE]}
              </label>
              <p className="muted consent-note">
                앱은 내가 멤버인 프로젝트에서, 내 프로젝트 권한 안에서만 동작합니다. '연결된 앱'에서 언제든 해제할 수 있습니다.
              </p>
            </fieldset>
            <div className="consent-actions">
              <button className="btn" disabled={busy} onClick={() => decide(false)}>
                거부
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>
                허용
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
