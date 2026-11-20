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

    # 공개 주소 — MCP 리소스(<public_url>/mcp)·OAuth 발급자(issuer)·동의 화면 주소
    public_url: str = "http://localhost:8000"  # 이 API 서버
    app_url: str = "http://localhost:5174"  # 웹 앱 (OAuth 동의 화면)
    mcp_access_token_ttl_sec: int = 3600
    mcp_refresh_token_ttl_days: int = 30
    # CIMD(Client ID Metadata Document) 가져올 때 사설·루프백 주소 허용 (테스트 전용, 운영 금지)
    oauth_allow_private_cimd: bool = False

    # 한글(HWPX/HWP) 변환 엔진 kordoc — server/tools/kordoc 에서 `npm ci` 로 설치 (Node.js 20+)
    kordoc_node: str = "node"
    kordoc_cli: Path = Path(__file__).resolve().parents[2] / "tools/kordoc/node_modules/kordoc/dist/cli.js"
    kordoc_timeout_sec: int = 120
