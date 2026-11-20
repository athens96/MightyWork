"""OAuth 2.1 인가 서버 (MCP 용) — 메타데이터, DCR, CIMD, 인가·동의, 토큰(PKCE), refresh 회전, 폐기."""

import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_google_verifier
from app.core.config import Settings
from app.main import create_app
from app.services.oauth import server as oauth
from tests.conftest import fake_verifier, login

BASE = "http://testserver"
REDIRECT = "http://127.0.0.1:33418/callback"


@pytest.fixture
def app(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path, jwt_secret="test-secret-0123456789-abcdefghijklmnop", public_url=BASE, app_url="http://app.test"))
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    return app


@pytest.fixture
def client(app):
    return TestClient(app, follow_redirects=False)


@pytest.fixture
def alice(app):
    return login(app, "u1:alice@example.com")


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def register(client, **extra):
    res = client.post("/oauth/register", json={"client_name": "테스트 에이전트", "redirect_uris": [REDIRECT], **extra})
    assert res.status_code == 201, res.text
    return res.json()


def authorize(client, alice, client_id, *, scope=None, approve=True, scopes=None, redirect=REDIRECT, resource=f"{BASE}/mcp"):
    verifier, challenge = pkce()
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect, "state": "st-1",
              "code_challenge": challenge, "code_challenge_method": "S256", "resource": resource}
    if scope:
        params["scope"] = scope
    res = client.get("/oauth/authorize", params=params)
    assert res.status_code == 302, res.text
    loc = res.headers["location"]
    assert loc.startswith("http://app.test/oauth/consent?request=")
    rid = parse_qs(urlsplit(loc).query)["request"][0]
    info = alice.get(f"/api/oauth/requests/{rid}").json()
    decision = alice.post(f"/api/oauth/requests/{rid}/decision", json={"approve": approve, "scopes": scopes or info["requested_scopes"]}).json()
    back = parse_qs(urlsplit(decision["redirect_to"]).query)
    return info, back, verifier


def token(client, **form):
    return client.post("/oauth/token", data=form)


def test_metadata_documents(client):
    m = client.get("/.well-known/oauth-authorization-server").json()
    assert m["issuer"] == f"{BASE}/"
    assert m["code_challenge_methods_supported"] == ["S256"]
    assert m["client_id_metadata_document_supported"] is True
    assert m["authorization_response_iss_parameter_supported"] is True
    prm = client.get("/.well-known/oauth-protected-resource/mcp").json()
    assert prm["resource"] == f"{BASE}/mcp" and prm["authorization_servers"] == [m["issuer"]]  # 정확히 일치해야 클라이언트가 통과
    root = client.get("/.well-known/oauth-protected-resource").json()
    assert root["authorization_servers"] == [m["issuer"]]


def test_mcp_requires_bearer(app):
    with TestClient(app) as c:
        res = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert res.status_code == 401
    assert f'resource_metadata="{BASE}/.well-known/oauth-protected-resource/mcp"' in res.headers["www-authenticate"]


def test_dcr_validates_redirect_uris(client):
    assert client.post("/oauth/register", json={"redirect_uris": ["http://evil.example.com/cb"]}).json()["error"] == "invalid_redirect_uri"
    assert client.post("/oauth/register", json={"redirect_uris": ["javascript:alert(1)"]}).status_code == 400
    assert client.post("/oauth/register", json={"redirect_uris": ["https://ok.example.com/cb#frag"]}).status_code == 400
    ok = register(client, redirect_uris=["https://claude.ai/api/mcp/auth_callback", "cursor://anysphere.cursor-retrieval/oauth/cb", REDIRECT])
    assert ok["client_id"].startswith("mwc_") and "client_secret" not in ok
    confidential = register(client, token_endpoint_auth_method="client_secret_post")
    assert confidential["client_secret"]


def test_full_code_flow_with_pkce_iss_and_refresh(client, alice):
    c = register(client)
    info, back, verifier = authorize(client, alice, c["client_id"])
    assert info["client_name"] == "테스트 에이전트" and info["registration"] == "dcr"
    assert info["requested_scopes"] == ["mightywork:read", "mightywork:write"]  # scope 생략 → 기본 읽기+쓰기
    assert back["state"] == ["st-1"] and back["iss"] == [f"{BASE}/"]  # RFC 9207
    code = back["code"][0]

    bad = token(client, grant_type="authorization_code", client_id=c["client_id"], code=code, redirect_uri=REDIRECT, code_verifier="x" * 50)
    assert bad.json()["error"] == "invalid_grant"
    # 코드는 일회용 — 위에서 이미 소비됨
    again = token(client, grant_type="authorization_code", client_id=c["client_id"], code=code, redirect_uri=REDIRECT, code_verifier=verifier)
    assert again.json()["error"] == "invalid_grant"

    _, back, verifier = authorize(client, alice, c["client_id"])
    res = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier, resource=f"{BASE}/mcp")
    assert res.status_code == 200 and res.headers["cache-control"] == "no-store"
    t = res.json()
    assert t["token_type"] == "Bearer" and t["scope"] == "mightywork:read mightywork:write"
    claims = oauth.verify_access_token(client.app.state.settings, client.app.state.db, t["access_token"])
    assert claims["sub"] == "u1" and claims["aud"] == f"{BASE}/mcp"

    # 웹 앱 API 는 MCP 토큰을 받지 않는다 (서명 키·aud 분리)
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {t['access_token']}"}).status_code == 401

    r1 = token(client, grant_type="refresh_token", client_id=c["client_id"], refresh_token=t["refresh_token"]).json()
    assert r1["access_token"] != t["access_token"] and r1["refresh_token"] != t["refresh_token"]
    # 회전된 옛 refresh 토큰 재사용 → 거부 + 이 연결의 refresh 토큰 전부 폐기
    assert token(client, grant_type="refresh_token", client_id=c["client_id"], refresh_token=t["refresh_token"]).json()["error"] == "invalid_grant"
    assert token(client, grant_type="refresh_token", client_id=c["client_id"], refresh_token=r1["refresh_token"]).json()["error"] == "invalid_grant"


def test_authorize_rejects_unknown_client_and_redirect_without_redirecting(client):
    assert client.get("/oauth/authorize", params={"client_id": "nope", "redirect_uri": REDIRECT}).status_code == 400
    c = register(client)
    res = client.get("/oauth/authorize", params={"client_id": c["client_id"], "redirect_uri": "http://127.0.0.1:1/other"})
    assert res.status_code == 400  # 오픈 리디렉트 금지


def test_authorize_errors_redirect_back_with_state_and_iss(client):
    c = register(client)
    common = {"client_id": c["client_id"], "redirect_uri": REDIRECT, "state": "s", "response_type": "code"}
    no_pkce = parse_qs(urlsplit(client.get("/oauth/authorize", params=common).headers["location"]).query)
    assert no_pkce["error"] == ["invalid_request"] and no_pkce["state"] == ["s"] and no_pkce["iss"] == [f"{BASE}/"]
    _, ch = pkce()
    other = parse_qs(urlsplit(client.get("/oauth/authorize", params=common | {"code_challenge": ch, "code_challenge_method": "S256", "resource": "https://other.example.com/mcp"}).headers["location"]).query)
    assert other["error"] == ["invalid_target"]
    bad_scope = parse_qs(urlsplit(client.get("/oauth/authorize", params=common | {"code_challenge": ch, "code_challenge_method": "S256", "scope": "admin"}).headers["location"]).query)
    assert bad_scope["error"] == ["invalid_scope"]


def test_loopback_redirect_any_port(client, alice):
    c = register(client)
    _, back, _ = authorize(client, alice, c["client_id"], redirect="http://127.0.0.1:50999/callback")
    assert "code" in back


def test_deny_and_read_only_consent(client, alice):
    c = register(client)
    _, denied, _ = authorize(client, alice, c["client_id"], approve=False)
    assert denied["error"] == ["access_denied"] and "code" not in denied
    _, back, verifier = authorize(client, alice, c["client_id"], scopes=["mightywork:read"])
    t = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier).json()
    assert t["scope"] == "mightywork:read"


def test_confidential_client_requires_secret(client, alice):
    c = register(client, token_endpoint_auth_method="client_secret_basic")
    _, back, verifier = authorize(client, alice, c["client_id"])
    form = dict(grant_type="authorization_code", client_id=c["client_id"], code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier)
    assert token(client, **form).status_code == 401
    basic = base64.b64encode(f"{c['client_id']}:{c['client_secret']}".encode()).decode()
    assert client.post("/oauth/token", data=form, headers={"Authorization": f"Basic {basic}"}).status_code == 200


def test_grants_list_and_disconnect_invalidates_tokens(client, alice, app):
    c = register(client)
    _, back, verifier = authorize(client, alice, c["client_id"])
    t = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier).json()
    grants = alice.get("/api/oauth/grants").json()
    assert [g["client_name"] for g in grants] == ["테스트 에이전트"]
    bob = login(app, "u2:bob@example.com")
    assert bob.delete(f"/api/oauth/grants/{grants[0]['id']}").status_code == 404  # 남의 연결은 못 지움
    assert alice.delete(f"/api/oauth/grants/{grants[0]['id']}").status_code == 204
    assert oauth.verify_access_token(app.state.settings, app.state.db, t["access_token"]) is None  # 액세스 토큰 즉시 무효
    assert token(client, grant_type="refresh_token", client_id=c["client_id"], refresh_token=t["refresh_token"]).json()["error"] == "invalid_grant"


def test_revoke_refresh_token(client, alice):
    c = register(client)
    _, back, verifier = authorize(client, alice, c["client_id"])
    t = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier).json()
    assert client.post("/oauth/revoke", data={"client_id": c["client_id"], "token": t["refresh_token"]}).status_code == 200
    assert token(client, grant_type="refresh_token", client_id=c["client_id"], refresh_token=t["refresh_token"]).json()["error"] == "invalid_grant"


def test_cimd_client(client, alice, monkeypatch):
    cid = "https://agent.example.com/oauth/client.json"
    doc = {"client_id": cid, "client_name": "CIMD 에이전트", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"}
    monkeypatch.setattr(oauth, "fetch_metadata", lambda url, allow_private=False: doc if url == cid else (_ for _ in ()).throw(oauth.CimdError("x")))
    info, back, verifier = authorize(client, alice, cid)
    assert info["registration"] == "cimd" and info["client_name"] == "CIMD 에이전트"
    t = token(client, grant_type="authorization_code", client_id=cid, code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier)
    assert t.status_code == 200
    assert client.app.state.db.oauth_clients.list() == []  # CIMD 는 저장하지 않음


def test_cimd_fetch_blocks_private_hosts():
    from app.services.oauth.cimd import CimdError, fetch_metadata

    for url in ["https://127.0.0.1/c.json", "https://localhost/c.json", "https://10.0.0.5/c.json", "http://example.com/c.json", "https://example.com/"]:
        with pytest.raises(CimdError):
            fetch_metadata(url)
