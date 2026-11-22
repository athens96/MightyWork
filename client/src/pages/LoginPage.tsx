import { useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/http";
import { APP_VERSION } from "../lib/version";
import { useTheme } from "../theme";

export function LoginPage() {
  const { user, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [theme] = useTheme();
  const fromLoc = (location.state as { from?: Location } | null)?.from;
  const from = fromLoc ? fromLoc.pathname + (fromLoc.search ?? "") : "/";

  if (user) return <Navigate to={from} replace />;

  return (
    <div className="login">
      <div className="card login-card">
        <img className="brand-logo" src="/mascot-256.png" alt="MightyWork" width={88} height={88} />
        <div>
          <h1 className="dash-title">
            MightyWork <span className="brand-ver">v{APP_VERSION}</span>
          </h1>
          <p className="dash-sub">프로젝트별 일감 파이프라인 · 위키</p>
        </div>
        <GoogleLogin
          onSuccess={async ({ credential }) => {
            if (!credential) return setError("구글 인증 정보를 받지 못했습니다.");
            try {
              await loginWithGoogle(credential);
              navigate(from, { replace: true });
            } catch (e) {
              setError(e instanceof ApiError ? e.message : "로그인에 실패했습니다.");
            }
          }}
          onError={() => setError("구글 로그인에 실패했습니다.")}
          shape="pill"
          theme={theme === "dark" ? "filled_black" : "outline"}
        />
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
