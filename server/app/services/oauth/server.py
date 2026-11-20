"""인가 서버 핵심 로직 — 메타데이터, 클라이언트 확인, 인가 요청·코드, 토큰 발급/검증/회전/폐기.

- OAuth 2.1: authorization_code + PKCE(S256 만), refresh_token(회전·재사용 탐지)
- RFC 8707 resource: 토큰은 이 MCP 서버(<public_url>/mcp) 전용(aud)
- RFC 9207: 인가 응답에 iss
- 클라이언트 등록: CIMD 우선, DCR(RFC 7591)은 호환용
"""

import base64
import hashlib
import hmac
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

import jwt

from app.core.config import Settings
from app.db import Database
from app.models.common import new_id, utcnow
from app.models.oauth import SCOPE_READ, SCOPE_WRITE, SCOPES, OAuthClient, OAuthGrant, RefreshToken
from app.services.oauth.cimd import CimdError, fetch_metadata, is_cimd_client_id

AUTH_REQUEST_TTL_SEC = 600  # 동의 화면에서 결정할 시간
CODE_TTL_SEC = 300  # 인가 코드 수명
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
FORBIDDEN_SCHEMES = {"javascript", "data", "file", "vbscript", "about", "blob"}


class OAuthError(Exception):
    """RFC 6749 오류 (error, error_description, HTTP 상태)."""

    def __init__(self, error: str, description: str, status: int = 400):
        super().__init__(description)
        self.error, self.description, self.status = error, description, status


# ------------------------------------------------------------------ 주소·키


def base_url(settings: Settings) -> str:
    return settings.public_url.rstrip("/")


def issuer(settings: Settings) -> str:
    """발급자 식별자. SDK 가 Protected Resource Metadata 에 쓰는 형태(끝 슬래시 포함)와 정확히 같아야
    클라이언트의 issuer 일치 검사(RFC 8414 §3.3, RFC 9207)를 통과한다."""
    return base_url(settings) + "/"


def resource_url(settings: Settings) -> str:
    return base_url(settings) + "/mcp"


def _token_key(settings: Settings) -> bytes:
    """MCP 액세스 토큰 서명 키 — 웹 앱 로그인 토큰과 다른 키(파생)로 섞이지 않게."""
    return hmac.new(settings.jwt_secret.encode(), b"mightywork/mcp-access-token/v1", hashlib.sha256).digest()


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def authorization_server_metadata(settings: Settings) -> dict:
    base = base_url(settings)
    return {
        "issuer": issuer(settings),
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "scopes_supported": list(SCOPES),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    }


# ------------------------------------------------------------------ 클라이언트


@dataclass
class ClientInfo:
    client_id: str
    client_name: str
    redirect_uris: list[str]
    auth_method: str
    secret_hash: str | None = None
    via: str = "dcr"  # dcr | cimd


def validate_redirect_uri(uri: str) -> None:
    parts = urlsplit(uri)
    if parts.fragment or not parts.scheme:
        raise OAuthError("invalid_redirect_uri", f"잘못된 redirect_uri: {uri}")
    scheme = parts.scheme.lower()
    if scheme in FORBIDDEN_SCHEMES:
        raise OAuthError("invalid_redirect_uri", f"허용하지 않는 스킴: {scheme}")
    if scheme == "http" and (parts.hostname or "") not in LOOPBACK_HOSTS:
        raise OAuthError("invalid_redirect_uri", "http redirect_uri 는 루프백(localhost) 주소만 허용합니다")
    if scheme == "https" and not parts.netloc:
        raise OAuthError("invalid_redirect_uri", f"잘못된 redirect_uri: {uri}")


def redirect_uri_matches(registered: list[str], requested: str) -> bool:
    """정확히 일치. 단 루프백 http 는 포트만 달라도 허용 (RFC 8252 §7.3)."""
    if requested in registered:
        return True
    req = urlsplit(requested)
    if req.scheme != "http" or (req.hostname or "") not in LOOPBACK_HOSTS:
        return False
    for r in registered:
        reg = urlsplit(r)
        if reg.scheme == "http" and reg.hostname == req.hostname and reg.path == req.path and reg.query == req.query:
            return True
    return False


def register_client(db: Database, metadata: dict, *, max_clients: int = 500) -> dict:
    """DCR (RFC 7591). 2026-07-28 에서 deprecated — CIMD 를 지원하지 않는 클라이언트 호환용."""
    if max_clients > 0 and len(db.oauth_clients.list()) >= max_clients:
        raise OAuthError("too_many_requests", "등록 가능한 동적 클라이언트 수 한도에 도달했습니다", 429)
    redirect_uris = metadata.get("redirect_uris")
    if not isinstance(redirect_uris, list) or not redirect_uris or not all(isinstance(u, str) for u in redirect_uris):
        raise OAuthError("invalid_redirect_uri", "redirect_uris 가 필요합니다")
    for uri in redirect_uris:
        validate_redirect_uri(uri)
    method = metadata.get("token_endpoint_auth_method", "none")
    if method not in ("none", "client_secret_post", "client_secret_basic"):
        raise OAuthError("invalid_client_metadata", f"지원하지 않는 token_endpoint_auth_method: {method}")
    grant_types = metadata.get("grant_types", ["authorization_code", "refresh_token"])
    if not set(grant_types) <= {"authorization_code", "refresh_token"}:
        raise OAuthError("invalid_client_metadata", "authorization_code / refresh_token 만 지원합니다")
    app_type = metadata.get("application_type", "native")
    if app_type not in ("web", "native"):
        raise OAuthError("invalid_client_metadata", "application_type 은 web 또는 native")
    name = str(metadata.get("client_name") or "이름 없는 앱")[:100]
    secret = secrets.token_urlsafe(32) if method != "none" else None
    client = db.oauth_clients.create(
        OAuthClient(
            client_id="mwc_" + secrets.token_urlsafe(18),
            client_secret_hash=_sha256(secret) if secret else None,
            client_name=name,
            redirect_uris=redirect_uris,
            token_endpoint_auth_method=method,
            application_type=app_type,
        )
    )
    out = {
        "client_id": client.client_id,
        "client_id_issued_at": int(client.created_at.timestamp()),
        "client_name": client.client_name,
        "redirect_uris": client.redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
        "application_type": app_type,
    }
    if secret:
        out |= {"client_secret": secret, "client_secret_expires_at": 0}
    return out


def get_client(settings: Settings, db: Database, client_id: str) -> ClientInfo:
    if is_cimd_client_id(client_id):
        try:
            doc = fetch_metadata(client_id, allow_private=settings.oauth_allow_private_cimd)
        except CimdError as e:
            raise OAuthError("invalid_client", str(e), 401) from e
        for uri in doc["redirect_uris"]:
            validate_redirect_uri(uri)
        name = doc.get("client_name") or urlsplit(client_id).hostname or client_id
        return ClientInfo(client_id, str(name)[:100], doc["redirect_uris"], "none", via="cimd")
    found = db.oauth_clients.list(lambda c: c.client_id == client_id)
    if not found:
        raise OAuthError("invalid_client", "등록되지 않은 클라이언트입니다", 401)
    c = found[0]
    return ClientInfo(c.client_id, c.client_name, c.redirect_uris, c.token_endpoint_auth_method, c.client_secret_hash)


def authenticate_client(client: ClientInfo, presented_secret: str | None) -> None:
    if client.auth_method == "none":
        return
    if not presented_secret or not client.secret_hash or not hmac.compare_digest(_sha256(presented_secret), client.secret_hash):
        raise OAuthError("invalid_client", "클라이언트 인증 실패", 401)


# ------------------------------------------------------------------ 인가 요청 (동의 화면 대기) · 코드


@dataclass
class PendingAuthorization:
    id: str
    client: ClientInfo
    redirect_uri: str
    state: str | None
    code_challenge: str
    scopes: list[str]
    resource: str
    expires: float = field(default_factory=lambda: time.monotonic() + AUTH_REQUEST_TTL_SEC)


@dataclass
class AuthorizationCode:
    user_id: str
    grant_id: str
    client_id: str
    redirect_uri: str
    code_challenge: str
    scopes: list[str]
    resource: str
    expires: float = field(default_factory=lambda: time.monotonic() + CODE_TTL_SEC)


class Store:
    """수명이 짧은 인가 요청·코드·요청 속도 제한을 메모리에 보관 (JSON 백엔드·단일 프로세스용)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pending: dict[str, PendingAuthorization] = {}
        self.codes: dict[str, AuthorizationCode] = {}
        self.dcr_hits: dict[str, list[float]] = {}

    def _sweep(self) -> None:
        now = time.monotonic()
        self.pending = {k: v for k, v in self.pending.items() if v.expires > now}
        self.codes = {k: v for k, v in self.codes.items() if v.expires > now}

    def check_dcr_rate_limit(self, key: str, limit_per_min: int) -> bool:
        if limit_per_min <= 0:
            return True
        now = time.monotonic()
        cutoff = now - 60.0
        with self.lock:
            hits = [t for t in self.dcr_hits.get(key, ()) if t > cutoff]
            if len(hits) >= limit_per_min:
                self.dcr_hits[key] = hits
                return False
            hits.append(now)
            self.dcr_hits[key] = hits
            # 오래된 키 정리
            if len(self.dcr_hits) > 1024:
                self.dcr_hits = {k: [t for t in v if t > cutoff] for k, v in self.dcr_hits.items() if any(t > cutoff for t in v)}
            return True

    def add_pending(self, p: PendingAuthorization) -> None:
        with self.lock:
            self._sweep()
            self.pending[p.id] = p

    def get_pending(self, pid: str) -> PendingAuthorization | None:
        with self.lock:
            self._sweep()
            return self.pending.get(pid)

    def pop_pending(self, pid: str) -> PendingAuthorization | None:
        with self.lock:
            self._sweep()
            return self.pending.pop(pid, None)

    def add_code(self, code: str, data: AuthorizationCode) -> None:
        with self.lock:
            self.codes[_sha256(code)] = data

    def pop_code(self, code: str) -> AuthorizationCode | None:
        with self.lock:
            self._sweep()
            return self.codes.pop(_sha256(code), None)  # 일회용


def normalize_resource(settings: Settings, resource: str | None) -> str:
    """resource(RFC 8707)는 이 MCP 서버여야 한다. 끝 슬래시 차이는 같은 것으로 본다. 없으면 기본값(구형 클라이언트 호환)."""
    expected = resource_url(settings)
    if resource is None or resource.rstrip("/") == expected:
        return expected
    raise OAuthError("invalid_target", f"이 인가 서버는 {expected} 용 토큰만 발급합니다")


def parse_scopes(scope: str | None) -> list[str]:
    if not scope:
        return [SCOPE_READ, SCOPE_WRITE]
    requested = scope.split()
    unknown = [s for s in requested if s not in SCOPES]
    if unknown:
        raise OAuthError("invalid_scope", f"알 수 없는 scope: {' '.join(unknown)}")
    return [s for s in SCOPES if s in requested]


def redirect_with(settings: Settings, redirect_uri: str, params: dict) -> str:
    params = {k: v for k, v in params.items() if v is not None} | {"iss": issuer(settings)}  # RFC 9207
    sep = "&" if "?" in redirect_uri else "?"
    return redirect_uri + sep + urlencode(params)


def approve(settings: Settings, db: Database, store: Store, pending: PendingAuthorization, user_id: str, scopes: list[str]) -> str:
    """사용자 동의 → grant 갱신 + 일회용 코드 → 클라이언트로 돌아갈 주소."""
    grant = next(iter(db.oauth_grants.list(lambda g: g.user_id == user_id and g.client_id == pending.client.client_id)), None)
    if grant is None:
        grant = db.oauth_grants.create(OAuthGrant(user_id=user_id, client_id=pending.client.client_id, client_name=pending.client.client_name, scopes=scopes))
    else:
        grant = grant.model_copy(update={"scopes": scopes, "client_name": pending.client.client_name, "updated_at": utcnow()})
        db.oauth_grants.update(grant)
        # 재동의에서 권한을 줄였다면 더 넓은 범위를 가진 기존 refresh 토큰을 폐기한다
        new_scope_set = set(scopes)
        for rt in db.refresh_tokens.list(lambda t: t.grant_id == grant.id):
            if not set(rt.scopes) <= new_scope_set:
                db.refresh_tokens.delete(rt.id)
    code = secrets.token_urlsafe(32)
    store.add_code(code, AuthorizationCode(user_id, grant.id, pending.client.client_id, pending.redirect_uri, pending.code_challenge, scopes, pending.resource))
    return redirect_with(settings, pending.redirect_uri, {"code": code, "state": pending.state})


# ------------------------------------------------------------------ 토큰


def _pkce_ok(verifier: str, challenge: str) -> bool:
    if not 43 <= len(verifier) <= 128:
        return False
    digest = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return hmac.compare_digest(digest, challenge)


def _issue(settings: Settings, db: Database, *, user_id: str, grant_id: str, client_id: str, scopes: list[str], resource: str) -> dict:
    now = datetime.now(timezone.utc)
    access = jwt.encode(
        {
            "iss": issuer(settings),
            "sub": user_id,
            "aud": resource,
            "client_id": client_id,
            "scope": " ".join(scopes),
            "grant": grant_id,
            "iat": now,
            "exp": now + timedelta(seconds=settings.mcp_access_token_ttl_sec),
            "jti": new_id(),
        },
        _token_key(settings),
        algorithm="HS256",
        headers={"typ": "at+jwt"},
    )
    refresh = secrets.token_urlsafe(40)
    db.refresh_tokens.create(
        RefreshToken(
            token_hash=_sha256(refresh),
            grant_id=grant_id,
            user_id=user_id,
            client_id=client_id,
            scopes=scopes,
            resource=resource,
            expires_at=now + timedelta(days=settings.mcp_refresh_token_ttl_days),
        )
    )
    return {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": settings.mcp_access_token_ttl_sec,
        "refresh_token": refresh,
        "scope": " ".join(scopes),
    }


def exchange_code(settings: Settings, db: Database, store: Store, form: dict, client: ClientInfo) -> dict:
    code = store.pop_code(form.get("code") or "")
    if code is None or code.client_id != client.client_id:
        raise OAuthError("invalid_grant", "인가 코드가 없거나 만료되었습니다")
    if form.get("redirect_uri") != code.redirect_uri:
        raise OAuthError("invalid_grant", "redirect_uri 가 인가 요청과 다릅니다")
    if not _pkce_ok(form.get("code_verifier") or "", code.code_challenge):
        raise OAuthError("invalid_grant", "PKCE code_verifier 가 맞지 않습니다")
    if normalize_resource(settings, form.get("resource")) != code.resource:
        raise OAuthError("invalid_target", "resource 가 인가 요청과 다릅니다")
    if db.oauth_grants.get(code.grant_id) is None:
        raise OAuthError("invalid_grant", "연결이 해제되었습니다")
    return _issue(settings, db, user_id=code.user_id, grant_id=code.grant_id, client_id=client.client_id, scopes=code.scopes, resource=code.resource)


def refresh(settings: Settings, db: Database, form: dict, client: ClientInfo) -> dict:
    token_hash = _sha256(form.get("refresh_token") or "")
    found = db.refresh_tokens.list(lambda t: t.token_hash == token_hash)
    if not found or found[0].client_id != client.client_id:
        raise OAuthError("invalid_grant", "refresh_token 이 유효하지 않습니다")
    rt = found[0]
    if rt.used:  # 이미 회전된 토큰 재사용 → 탈취로 간주, 이 연결의 refresh 토큰 전부 폐기
        for t in db.refresh_tokens.list(lambda t: t.grant_id == rt.grant_id):
            db.refresh_tokens.delete(t.id)
        raise OAuthError("invalid_grant", "이미 사용된 refresh_token 입니다 — 다시 로그인하세요")
    grant = db.oauth_grants.get(rt.grant_id)
    if rt.expires_at <= datetime.now(timezone.utc) or grant is None:
        raise OAuthError("invalid_grant", "refresh_token 이 만료되었거나 연결이 해제되었습니다")
    if not set(rt.scopes) <= set(grant.scopes):
        raise OAuthError("invalid_grant", "연결 권한이 축소되어 refresh_token 을 사용할 수 없습니다")
    resource = normalize_resource(settings, form.get("resource")) if form.get("resource") else rt.resource
    if resource != rt.resource:
        raise OAuthError("invalid_target", "resource 가 다릅니다")
    scopes = rt.scopes
    if form.get("scope"):  # 축소만 허용
        requested = parse_scopes(form["scope"])
        if not set(requested) <= set(rt.scopes):
            raise OAuthError("invalid_scope", "처음 허용한 범위를 넘을 수 없습니다")
        scopes = requested
    db.refresh_tokens.update(rt.model_copy(update={"used": True}))
    return _issue(settings, db, user_id=rt.user_id, grant_id=rt.grant_id, client_id=client.client_id, scopes=scopes, resource=rt.resource)


def revoke(db: Database, token: str, client: ClientInfo) -> None:
    """RFC 7009 — refresh_token 폐기 (모르는 토큰도 200). 액세스 토큰은 수명이 짧아 grant 해제로 무효화."""
    token_hash = _sha256(token)
    for t in db.refresh_tokens.list(lambda t: t.token_hash == token_hash and t.client_id == client.client_id):
        db.refresh_tokens.delete(t.id)


def revoke_grant(db: Database, grant: OAuthGrant) -> None:
    for t in db.refresh_tokens.list(lambda t: t.grant_id == grant.id):
        db.refresh_tokens.delete(t.id)
    db.oauth_grants.delete(grant.id)


def verify_access_token(settings: Settings, db: Database, token: str) -> dict | None:
    """서명·만료·발급자·aud(=이 MCP 서버) 확인 + 연결(grant)이 살아 있는지."""
    try:
        claims = jwt.decode(
            token,
            _token_key(settings),
            algorithms=["HS256"],
            audience=resource_url(settings),
            issuer=issuer(settings),
            options={"require": ["exp", "sub", "aud", "iss", "grant"]},
        )
    except jwt.PyJWTError:
        return None
    grant = db.oauth_grants.get(claims["grant"])
    if grant is None or grant.user_id != claims["sub"] or db.users.get(claims["sub"]) is None:
        return None
    token_scopes = set(str(claims.get("scope", "")).split())
    if not token_scopes <= set(grant.scopes):
        return None
    now = utcnow()
    if grant.last_used_at is None or now - grant.last_used_at > timedelta(minutes=5):
        db.oauth_grants.update(grant.model_copy(update={"last_used_at": now}))
    return claims
