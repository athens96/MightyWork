from typing import Callable, TypedDict

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token


class GoogleIdentity(TypedDict):
    sub: str
    email: str
    email_verified: bool
    name: str
    picture: str | None


GoogleVerifier = Callable[[str, str], GoogleIdentity]


def verify_google_credential(credential: str, client_id: str) -> GoogleIdentity:
    """구글 ID 토큰의 서명/만료/aud 를 검증한다. 실패 시 ValueError."""
    if not client_id:
        raise ValueError("GOOGLE_CLIENT_ID is not configured")
    info = id_token.verify_oauth2_token(credential, google_requests.Request(), client_id)
    return GoogleIdentity(
        sub=info["sub"],
        email=info["email"],
        email_verified=bool(info.get("email_verified")),
        name=info.get("name", ""),
        picture=info.get("picture"),
    )
