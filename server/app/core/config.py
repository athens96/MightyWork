from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "MightyWork"

    # Google 로그인
    google_client_id: str = ""
    allowed_email_domains: list[str] = []  # 비어 있으면 도메인 제한 없음

    # 자체 발급 JWT (구글 ID 토큰 검증 후 발급)
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24

    # 파일 DB
    data_dir: Path = Path("data")

    cors_origins: list[str] = ["http://localhost:5174"]
