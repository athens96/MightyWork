from datetime import datetime

from pydantic import BaseModel

from app.models.common import Entity


class User(Entity):
    """id 는 구글 계정의 고유 식별자(sub)를 그대로 사용한다."""

    email: str
    name: str = ""
    picture: str | None = None
    last_login_at: datetime | None = None


class GoogleLoginRequest(BaseModel):
    credential: str  # 클라이언트가 Google Identity Services 로 받은 ID 토큰


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: User
