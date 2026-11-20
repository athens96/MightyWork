from app.core.config import Settings
from app.main import create_app
from app.api.deps import get_google_verifier
from fastapi.testclient import TestClient

from tests.conftest import fake_verifier


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_requires_auth(client):
    assert client.get("/api/projects").status_code == 401
    assert client.get("/api/projects/x/tasks").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_google_login_creates_user_and_me(auth_client):
    me = auth_client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"


def test_invalid_google_credential(client):
    assert client.post("/api/auth/google", json={"credential": "invalid"}).status_code == 401


def test_domain_allowlist(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path, jwt_secret="test-secret-0123456789-abcdefghijklmnop", allowed_email_domains=["corp.com"])
    app = create_app(settings)
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    client = TestClient(app)
    assert client.post("/api/auth/google", json={"credential": "u1:a@gmail.com"}).status_code == 403
    assert client.post("/api/auth/google", json={"credential": "u2:b@corp.com"}).status_code == 200


def test_data_persists_across_restart(settings, auth_client, project):
    auth_client.post(f"/api/projects/{project['id']}/tasks", json={"title": "persist me"})
    app2 = create_app(settings)
    titles = [t.title for t in app2.state.db.tasks.list()]
    assert titles == ["persist me"]
