"""OAuth 2.1 인가 서버 엔드포인트 (MCP 클라이언트용) + 동의 화면·연결된 앱 API."""

import base64
import secrets
from html import escape
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from app.api.deps import CurrentUser, DbDep, SettingsDep
from app.models.oauth import SCOPE_LABEL, SCOPES, GrantRead
from app.services.oauth import server as oauth
from app.services.oauth.server import OAuthError, PendingAuthorization, Store

public = APIRouter(tags=["oauth"])  # 루트에 붙음 (/.well-known, /oauth/*)
api = APIRouter(prefix="/oauth", tags=["oauth"])  # /api/oauth/* (웹 앱 로그인 사용자)

NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _store(request: Request) -> Store:
    return request.app.state.oauth_store


def _error(e: OAuthError) -> JSONResponse:
    headers = dict(NO_STORE)
    if e.status == 401:
        headers["WWW-Authenticate"] = 'Basic realm="oauth"'
    return JSONResponse({"error": e.error, "error_description": e.description}, status_code=e.status, headers=headers)


def _error_page(message: str) -> HTMLResponse:
    """client_id / redirect_uri 가 확인되지 않으면 리디렉트하지 않고 여기서 멈춘다 (오픈 리디렉트 방지)."""
    return HTMLResponse(
        f"<!doctype html><meta charset=utf-8><title>연결 오류</title>"
        f"<body style='font-family:system-ui;max-width:520px;margin:80px auto;color:#0e1320'>"
        f"<h2>앱 연결을 진행할 수 없습니다</h2><p>{escape(message)}</p></body>",
        status_code=400,
    )


@public.get("/.well-known/oauth-authorization-server")
def as_metadata(settings: SettingsDep) -> JSONResponse:
    """RFC 8414 인가 서버 메타데이터."""
    return JSONResponse(oauth.authorization_server_metadata(settings))


@public.post("/oauth/register", status_code=status.HTTP_201_CREATED)
async def register(request: Request, db: DbDep) -> JSONResponse:
    """RFC 7591 동적 등록 — 2026-07-28 에서 deprecated (CIMD 우선), 호환을 위해 유지."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError
    except ValueError:
        return _error(OAuthError("invalid_client_metadata", "JSON 본문이 필요합니다"))
    try:
        return JSONResponse(oauth.register_client(db, body), status_code=201, headers=NO_STORE)
    except OAuthError as e:
        return _error(e)


@public.get("/oauth/authorize")
def authorize(request: Request, settings: SettingsDep, db: DbDep):
    q = request.query_params
    # 1) 클라이언트·redirect_uri 확인 — 실패 시 리디렉트하지 않음
    try:
        client = oauth.get_client(settings, db, q.get("client_id") or "")
    except OAuthError as e:
        return _error_page(e.description)
    redirect_uri = q.get("redirect_uri")
    if not redirect_uri and len(client.redirect_uris) == 1:
        redirect_uri = client.redirect_uris[0]
    if not redirect_uri or not oauth.redirect_uri_matches(client.redirect_uris, redirect_uri):
        return _error_page("등록되지 않은 redirect_uri 입니다.")
    state = q.get("state")

    # 2) 나머지 오류는 클라이언트로 돌려보냄 (state·iss 포함)
    def fail(error: str, description: str):
        return RedirectResponse(oauth.redirect_with(settings, redirect_uri, {"error": error, "error_description": description, "state": state}), 302)

    if q.get("response_type") != "code":
        return fail("unsupported_response_type", "response_type=code 만 지원합니다")
    if not q.get("code_challenge") or q.get("code_challenge_method") != "S256":
        return fail("invalid_request", "PKCE(code_challenge_method=S256)가 필요합니다")
    try:
        scopes = oauth.parse_scopes(q.get("scope"))
        resource = oauth.normalize_resource(settings, q.get("resource"))
    except OAuthError as e:
        return fail(e.error, e.description)

    pending = PendingAuthorization(
        id=secrets.token_urlsafe(24), client=client, redirect_uri=redirect_uri, state=state,
        code_challenge=q["code_challenge"], scopes=scopes, resource=resource,
    )
    _store(request).add_pending(pending)
    # 3) 웹 앱 동의 화면으로 (로그인 안 되어 있으면 구글 로그인 후 돌아옴)
    return RedirectResponse(f"{settings.app_url.rstrip('/')}/oauth/consent?request={pending.id}", 302)


def _client_auth(request: Request, form: dict) -> tuple[str, str | None]:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            cid, _, secret = base64.b64decode(header[6:]).decode().partition(":")
            return unquote(cid), unquote(secret)
        except ValueError as e:
            raise OAuthError("invalid_client", "Basic 인증 형식 오류", 401) from e
    return form.get("client_id") or "", form.get("client_secret")


@public.post("/oauth/token")
async def token(request: Request, settings: SettingsDep, db: DbDep) -> JSONResponse:
    form = {k: str(v) for k, v in (await request.form()).items()}
    try:
        client_id, secret = _client_auth(request, form)
        client = oauth.get_client(settings, db, client_id)
        oauth.authenticate_client(client, secret)
        grant_type = form.get("grant_type")
        if grant_type == "authorization_code":
            body = oauth.exchange_code(settings, db, _store(request), form, client)
        elif grant_type == "refresh_token":
            body = oauth.refresh(settings, db, form, client)
        else:
            raise OAuthError("unsupported_grant_type", f"지원하지 않는 grant_type: {grant_type}")
    except OAuthError as e:
        return _error(e)
    return JSONResponse(body, headers=NO_STORE)


@public.post("/oauth/revoke")
async def revoke(request: Request, settings: SettingsDep, db: DbDep) -> Response:
    form = {k: str(v) for k, v in (await request.form()).items()}
    try:
        client_id, secret = _client_auth(request, form)
        client = oauth.get_client(settings, db, client_id)
        oauth.authenticate_client(client, secret)
    except OAuthError as e:
        return _error(e)
    oauth.revoke(db, form.get("token", ""), client)
    return Response(status_code=200)


# ------------------------------------------------------------------ 동의 화면 · 연결된 앱 (웹 앱 사용자)


class ConsentRequest(BaseModel):
    client_id: str
    client_name: str
    registration: str  # cimd | dcr
    redirect_host: str
    requested_scopes: list[str]
    scope_labels: dict[str, str]


class Decision(BaseModel):
    approve: bool
    scopes: list[str] = []  # 사용자가 고른 범위 (읽기만 / 읽기+쓰기)


@api.get("/requests/{request_id}", response_model=ConsentRequest)
def get_request(request_id: str, request: Request, _: CurrentUser) -> ConsentRequest:
    p = _store(request).get_pending(request_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "연결 요청이 없거나 만료되었습니다. 앱에서 다시 시도하세요.")
    return ConsentRequest(
        client_id=p.client.client_id,
        client_name=p.client.client_name,
        registration=p.client.via,
        redirect_host=urlsplit(p.redirect_uri).netloc or urlsplit(p.redirect_uri).scheme + ":",
        requested_scopes=p.scopes,
        scope_labels=SCOPE_LABEL,
    )


@api.post("/requests/{request_id}/decision")
def decide(request_id: str, body: Decision, request: Request, user: CurrentUser, settings: SettingsDep, db: DbDep) -> dict:
    p = _store(request).pop_pending(request_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "연결 요청이 없거나 만료되었습니다. 앱에서 다시 시도하세요.")
    if not body.approve:
        return {"redirect_to": oauth.redirect_with(settings, p.redirect_uri, {"error": "access_denied", "error_description": "사용자가 거부했습니다", "state": p.state})}
    scopes = [s for s in SCOPES if s in body.scopes] or p.scopes
    if oauth.SCOPE_READ not in scopes:
        scopes = [oauth.SCOPE_READ, *scopes]  # 읽기는 항상 포함 (MCP 서버 필수 범위)
    return {"redirect_to": oauth.approve(settings, db, _store(request), p, user.id, scopes)}


@api.get("/grants", response_model=list[GrantRead])
def list_grants(user: CurrentUser, db: DbDep) -> list[GrantRead]:
    grants = sorted(db.oauth_grants.list(lambda g: g.user_id == user.id), key=lambda g: g.created_at)
    return [GrantRead(**g.model_dump()) for g in grants]


@api.delete("/grants/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_grant(grant_id: str, user: CurrentUser, db: DbDep) -> Response:
    """연결 해제 — 그 앱의 refresh 토큰 삭제 + 액세스 토큰 즉시 무효 (검증 시 grant 확인)."""
    g = db.oauth_grants.get(grant_id)
    if g is None or g.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "연결을 찾을 수 없습니다")
    oauth.revoke_grant(db, g)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
