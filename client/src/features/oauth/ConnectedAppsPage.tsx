import { useEffect, useState } from "react";
import { oauthApi } from "../../api";
import { TrashIcon } from "../../components/icons";
import { timeAgo } from "../../lib/time";
import type { McpInfo, OAuthGrant } from "../../types";

const SCOPE_SHORT: Record<string, string> = { "mightywork:read": "읽기", "mightywork:write": "쓰기" };

/** 연결된 앱(MCP 클라이언트) 관리 + 연결 방법 안내 */
export function ConnectedAppsPage() {
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    oauthApi.grants().then(setGrants);
    oauthApi.mcpInfo().then(setInfo);
  }, []);

  const revoke = async (g: OAuthGrant) => {
    if (!confirm(`'${g.client_name}' 연결을 해제할까요?\n그 앱은 즉시 MightyWork 에 접근할 수 없게 됩니다.`)) return;
    await oauthApi.revokeGrant(g.id);
    setGrants((prev) => prev.filter((x) => x.id !== g.id));
  };

  const copy = (key: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const url = info?.url ?? "";
  const snippets = [
    { key: "claude", label: "Claude Code", value: `claude mcp add --transport http mightywork ${url}` },
    { key: "json", label: "Cursor · Claude Desktop 등 (mcp.json)", value: JSON.stringify({ mcpServers: { mightywork: { url } } }, null, 2) },
  ];

  return (
    <div>
      <header className="page-head">
        <div>
          <h1 className="dash-title">연결된 앱</h1>
          <p className="dash-sub">MCP 로 MightyWork 에 접근하는 AI 앱 · 내 계정의 권한 안에서만 동작합니다</p>
        </div>
      </header>

      <section className="card mcp-connect">
        <h3>MCP 서버 주소</h3>
        <div className="copy-row">
          <code className="mono">{url}</code>
          <button className="btn btn-sm" onClick={() => copy("url", url)}>
            {copied === "url" ? "복사됨" : "복사"}
          </button>
        </div>
        <p className="muted mcp-help">
          앱에 이 주소를 추가하면 브라우저에서 MightyWork 로그인·동의 화면이 열립니다 (OAuth 2.1, MCP 2026-07-28). 허용하면 연결됩니다.
        </p>
        {snippets.map((s) => (
          <div key={s.key} className="snippet">
            <div className="snippet-head">
              <span>{s.label}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => copy(s.key, s.value)}>
                {copied === s.key ? "복사됨" : "복사"}
              </button>
            </div>
            <pre>{s.value}</pre>
          </div>
        ))}
      </section>

      <div className="group-head">
        <span className="group-title">허용한 앱 {grants.length}</span>
      </div>
      {grants.length === 0 ? (
        <div className="card empty">아직 연결된 앱이 없습니다.</div>
      ) : (
        <div className="card rows">
          {grants.map((g) => (
            <div key={g.id} className="row">
              <span className="key-badge">MCP</span>
              <span className="row-main">
                <span className="row-title">
                  {g.client_name}{" "}
                  {g.scopes.map((s) => (
                    <span key={s} className={`pill ${s.endsWith("write") ? "tone-wait" : "tone-run"}`}>
                      {SCOPE_SHORT[s] ?? s}
                    </span>
                  ))}
                </span>
                <span className="row-meta">
                  {timeAgo(g.created_at)} 연결 · {g.last_used_at ? `${timeAgo(g.last_used_at)} 사용` : "아직 사용 안 함"} · <span className="mono">{g.client_id.length > 48 ? g.client_id.slice(0, 48) + "…" : g.client_id}</span>
                </span>
              </span>
              <button className="btn btn-sm btn-danger" onClick={() => revoke(g)}>
                <TrashIcon size={12} /> 해제
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
