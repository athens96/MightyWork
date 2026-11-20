from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import CurrentUser, DbDep, SettingsDep, get_google_verifier
from app.core.security import create_access_token
from app.models.common import utcnow
from app.models.user import GoogleLoginRequest, TokenResponse, User
from app.services.google_auth import GoogleVerifier

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/google", response_model=TokenResponse)
def login_with_google(
    body: GoogleLoginRequest,
    settings: SettingsDep,
    db: DbDep,
    verify: Annotated[GoogleVerifier, Depends(get_google_verifier)],
) -> TokenResponse:
    """클라이언트가 받은 구글 ID 토큰을 검증하고 자체 액세스 토큰을 발급한다."""
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

    return TokenResponse(access_token=create_access_token(user.id, settings), user=user)


@router.get("/me", response_model=User)
def me(user: CurrentUser) -> User:
    return user
