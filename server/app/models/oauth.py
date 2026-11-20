"""MCP 용 OAuth 2.1 인가 서버 데이터."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.models.common import Entity

SCOPE_READ = "mightywork:read"
SCOPE_WRITE = "mightywork:write"
SCOPES = (SCOPE_READ, SCOPE_WRITE)
SCOPE_LABEL = {SCOPE_READ: "프로젝트·일감·위키 읽기", SCOPE_WRITE: "일감·위키 만들기와 고치기, 덧글 쓰기"}


class OAuthClient(Entity):
    """동적 등록(DCR, RFC 7591 — 2026-07-28 에서 deprecated, 호환용)으로 만든 클라이언트.
    CIMD 클라이언트는 저장하지 않고 메타데이터 문서를 가져와 쓴다."""

    client_id: str
    client_secret_hash: str | None = None  # 기밀 클라이언트만
    client_name: str
    redirect_uris: list[str]
    token_endpoint_auth_method: Literal["none", "client_secret_post", "client_secret_basic"] = "none"
    application_type: Literal["web", "native"] = "native"


class OAuthGrant(Entity):
    """사용자가 클라이언트(앱)에 허용한 접근 — '연결된 앱'. 지우면 그 앱의 모든 토큰이 무효."""

    user_id: str
    client_id: str
    client_name: str
    scopes: list[str]
    last_used_at: datetime | None = None


class RefreshToken(Entity):
    token_hash: str  # sha256 — 원문은 저장하지 않는다
    grant_id: str
    user_id: str
    client_id: str
    scopes: list[str]
    resource: str
    expires_at: datetime
    used: bool = False  # 회전된 토큰 — 다시 쓰이면 탈취로 보고 grant 의 토큰을 모두 폐기


class GrantRead(BaseModel):
    id: str
    client_id: str
    client_name: str
    scopes: list[str]
    created_at: datetime
    last_used_at: datetime | None
