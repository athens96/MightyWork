from datetime import datetime, timedelta, timezone
import hashlib
import hmac

import jwt

from app.core.config import Settings


def _refresh_key(settings: Settings) -> bytes:
    """웹 리프레시 토큰 전용 키 — 액세스 토큰·MCP 토큰과 서명 키를 분리한다."""
    return hmac.new(settings.jwt_secret.encode(), b"mightywork/web-refresh-token/v1", hashlib.sha256).digest()


def create_access_token(user_id: str, settings: Settings) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expire_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str, settings: Settings) -> str:
    """토큰을 검증하고 user_id(sub)를 반환한다. 실패 시 jwt.PyJWTError."""
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    return payload["sub"]


def create_refresh_token(user_id: str, settings: Settings) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "typ": "web_refresh",
        "iat": now,
        "exp": now + timedelta(days=settings.web_refresh_token_ttl_days),
    }
    return jwt.encode(payload, _refresh_key(settings), algorithm="HS256")


def decode_refresh_token(token: str, settings: Settings) -> str:
    """웹 리프레시 토큰 검증 후 user_id(sub)를 반환. 실패 시 jwt.PyJWTError."""
    payload = jwt.decode(
        token,
        _refresh_key(settings),
        algorithms=["HS256"],
        options={"require": ["sub", "exp", "typ"]},
    )
    if payload.get("typ") != "web_refresh":
        raise jwt.InvalidTokenError("invalid token type")
    return payload["sub"]
