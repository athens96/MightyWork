from typing import Annotated

import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, SettingsDep, get_google_verifier
from app.core.security import create_access_token, create_refresh_token, decode_refresh_token
from app.models.common import utcnow
from app.models.user import GoogleLoginRequest, TokenResponse, User
from app.services.google_auth import GoogleVerifier

router = APIRouter(prefix="/auth", tags=["auth"])
REFRESH_COOKIE = "mw_refresh"


def _set_refresh_cookie(response: Response, user_id: str, settings) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=create_refresh_token(user_id, settings),
        httponly=True,
        secure=settings.public_url.startswith("https://"),
        samesite="lax",
        path="/api/auth",
        max_age=settings.web_refresh_token_ttl_days * 86400,
    )


@router.post("/google", response_model=TokenResponse)
def login_with_google(
    body: GoogleLoginRequest,
    response: Response,
    settings: SettingsDep,
    db: DbDep,
    verify: Annotated[GoogleVerifier, Depends(get_google_verifier)],
) -> TokenResponse:
    """클라이언트가 받은 구글 ID 토큰을 검증하고 자체 액세스 토큰(+ HttpOnly 리프레시 쿠키)을 발급한다."""
    try:
        identity = verify(body.credential, settings.google_client_id)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid Google credential")

    if not identity["email_verified"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Email not verified")

    domain = identity["email"].rsplit("@", 1)[-1].lower()
    allowed = [d.lower() for d in settings.allowed_email_domains]
    if allowed and domain not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Email domain not allowed")

    now = utcnow()
    user = db.users.get(identity["sub"])
    if user is None:
        user = db.users.create(
            User(
                id=identity["sub"],
                email=identity["email"],
                name=identity["name"],
                picture=identity["picture"],
                last_login_at=now,
            )
        )
    else:
        user = user.model_copy(
            update={
                "email": identity["email"],
                "name": identity["name"],
                "picture": identity["picture"],
                "last_login_at": now,
                "updated_at": now,
            }
        )
        db.users.update(user)

    _set_refresh_cookie(response, user.id, settings)
    return TokenResponse(access_token=create_access_token(user.id, settings), user=user)


@router.post("/refresh", response_model=TokenResponse)
def refresh_session(
    response: Response,
    settings: SettingsDep,
    db: DbDep,
    mw_refresh: str | None = Cookie(default=None),
) -> TokenResponse:
    """HttpOnly 리프레시 쿠키로 새 액세스 토큰을 발급한다."""
    if not mw_refresh:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token missing")
    try:
        user_id = decode_refresh_token(mw_refresh, settings)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    user = db.users.get(user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    _set_refresh_cookie(response, user.id, settings)
    return TokenResponse(access_token=create_access_token(user.id, settings), user=user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response) -> Response:
    response.delete_cookie(key=REFRESH_COOKIE, path="/api/auth")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=User)
def me(user: CurrentUser) -> User:
    return user
