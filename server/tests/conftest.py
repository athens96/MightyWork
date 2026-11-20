import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_google_verifier
from app.core.config import Settings
from app.main import create_app


def fake_verifier(credential: str, client_id: str):
    """credential 문자열을 '<sub>:<email>' 로 해석하는 가짜 구글 검증기."""
    if credential == "invalid":
        raise ValueError("bad token")
    sub, email = credential.split(":", 1)
    return {"sub": sub, "email": email, "email_verified": True, "name": sub, "picture": None}


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(_env_file=None, data_dir=tmp_path, jwt_secret="test-secret-0123456789-abcdefghijklmnop", google_client_id="test")


@pytest.fixture
def app(settings):
    app = create_app(settings)
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    return app


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def auth_client(client) -> TestClient:
    res = client.post("/api/auth/google", json={"credential": "u1:alice@example.com"})
    assert res.status_code == 200, res.text
    client.headers["Authorization"] = f"Bearer {res.json()['access_token']}"
    return client


@pytest.fixture
def project(auth_client) -> dict:
    res = auth_client.post("/api/projects", json={"key": "MW", "name": "MightyWork"})
    assert res.status_code == 201, res.text
    return res.json()


def login(app, credential: str) -> TestClient:
    """credential '<sub>:<email>' 로 로그인한 별도 클라이언트."""
    client = TestClient(app)
    res = client.post("/api/auth/google", json={"credential": credential})
    assert res.status_code == 200, res.text
    client.headers["Authorization"] = f"Bearer {res.json()['access_token']}"
    return client
