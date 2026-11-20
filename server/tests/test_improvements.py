"""우선순위 개선 사항 검증 테스트:
- 위키 제목 변경 전파 시 코드 블록 보존
- 사용자 목록 프로젝트 범위 격리 (/api/users, /api/projects/{id}/users)
- OAuth 2.1 재동의 권한 축소 즉시 반영, 요청 범위 초과 승인 차단, DCR 속도·개수 제한, CIMD DNS·캐시 하드닝
- SQLite 저장소 + FTS5 검색 + 기존 JSON 자동 마이그레이션 + JSON 백엔드 호환
- 웹 세션 HttpOnly 리프레시 쿠키 갱신/로그아웃 + 보안 응답 헤더
- 프로젝트 첨부 파일 업로드/다운로드/격리/삭제
"""

import socket

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_google_verifier
from app.core.config import Settings
from app.db import Database
from app.main import create_app
from app.models.project import Project
from app.models.task import Task
from app.models.user import User
from app.models.wiki import WikiPage
from app.services.links import rename_links
from app.services.oauth import cimd, server as oauth
from tests.conftest import fake_verifier, login
from tests.test_oauth import BASE, REDIRECT, authorize, register, token


def test_rename_links_preserves_code_blocks(auth_client, project):
    md = "본문 [[Old Page]] 와 [[old page|표시]]\n인라인 `[[Old Page]]`\n```md\n[[Old Page]]\n```"
    assert rename_links(md, "Old Page", "New Page") == (
        "본문 [[New Page]] 와 [[New Page|표시]]\n인라인 `[[Old Page]]`\n```md\n[[Old Page]]\n```"
    )

    pid = project["id"]
    target = auth_client.post(f"/api/projects/{pid}/wiki/pages", json={"title": "구 문서"}).json()
    src = auth_client.post(
        f"/api/projects/{pid}/wiki/pages",
        json={"title": "참조", "content": "링크 [[구 문서]], 코드 `[[구 문서]]`\n```\n[[구 문서]]\n```"},
    ).json()
    auth_client.patch(f"/api/projects/{pid}/wiki/pages/{target['id']}", json={"title": "신 문서"})
    updated = auth_client.get(f"/api/projects/{pid}/wiki/pages/{src['id']}").json()["content"]
    assert updated == "링크 [[신 문서]], 코드 `[[구 문서]]`\n```\n[[구 문서]]\n```"


def test_users_are_scoped_to_accessible_projects(app, auth_client, project):
    pid = project["id"]
    bob = login(app, "u2:bob@example.com")
    carol = login(app, "u3:carol@example.com")

    # 서로 프로젝트가 겹치지 않으면 /api/users 에 노출되지 않는다
    assert [u["email"] for u in auth_client.get("/api/users").json()] == ["alice@example.com"]
    assert [u["email"] for u in bob.get("/api/users").json()] == ["bob@example.com"]
    assert bob.get(f"/api/projects/{pid}/users").status_code == 404

    # carol 을 프로젝트에 초대하면 서로 보임 (bob 은 여전히 비노출)
    m = auth_client.post(f"/api/projects/{pid}/members", json={"email": "carol@example.com"}).json()
    assert {u["email"] for u in auth_client.get("/api/users").json()} == {"alice@example.com", "carol@example.com"}
    assert {u["email"] for u in auth_client.get(f"/api/projects/{pid}/users").json()} == {"alice@example.com", "carol@example.com"}

    # carol 이 일감을 작성한 뒤 프로젝트에서 제거돼도 보고자 표시를 위해 해당 프로젝트 사용자 목록에는 남는다
    carol.post(f"/api/projects/{pid}/tasks", json={"title": "carol task"})
    auth_client.delete(f"/api/projects/{pid}/members/{m['id']}")
    assert {u["email"] for u in auth_client.get(f"/api/projects/{pid}/users").json()} == {"alice@example.com", "carol@example.com"}
    assert [u["email"] for u in carol.get("/api/users").json()] == ["carol@example.com"]


def test_oauth_reconsent_narrowing_invalidates_broader_tokens(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path, jwt_secret="test-secret-0123456789-abcdefghijklmnop", public_url=BASE, app_url="http://app.test"))
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    client = TestClient(app, follow_redirects=False)
    alice = login(app, "u1:alice@example.com")

    c = register(client)
    # 1) 읽기+쓰기 허용 후 토큰 발급
    _, back1, v1 = authorize(client, alice, c["client_id"], scopes=["mightywork:read", "mightywork:write"])
    t1 = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back1["code"][0], redirect_uri=REDIRECT, code_verifier=v1).json()
    assert oauth.verify_access_token(app.state.settings, app.state.db, t1["access_token"]) is not None

    # 2) 같은 앱을 읽기 전용으로 재동의 → 기존 쓰기 포함 액세스·리프레시 토큰 즉시 무효
    _, back2, v2 = authorize(client, alice, c["client_id"], scopes=["mightywork:read"])
    assert oauth.verify_access_token(app.state.settings, app.state.db, t1["access_token"]) is None
    assert token(client, grant_type="refresh_token", client_id=c["client_id"], refresh_token=t1["refresh_token"]).json()["error"] == "invalid_grant"

    # 새 읽기 전용 토큰은 정상 동작
    t2 = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back2["code"][0], redirect_uri=REDIRECT, code_verifier=v2).json()
    assert t2["scope"] == "mightywork:read"
    assert oauth.verify_access_token(app.state.settings, app.state.db, t2["access_token"]) is not None


def test_oauth_consent_cannot_escalate_beyond_requested_scopes(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path, jwt_secret="test-secret-0123456789-abcdefghijklmnop", public_url=BASE, app_url="http://app.test"))
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    client = TestClient(app, follow_redirects=False)
    alice = login(app, "u1:alice@example.com")

    c = register(client)
    # 클라이언트는 read 만 요청했는데, 동의 응답이 write 까지 보내도 read 로 제한된다
    _, back, verifier = authorize(client, alice, c["client_id"], scope="mightywork:read", scopes=["mightywork:read", "mightywork:write"])
    t = token(client, grant_type="authorization_code", client_id=c["client_id"], code=back["code"][0], redirect_uri=REDIRECT, code_verifier=verifier).json()
    assert t["scope"] == "mightywork:read"


def test_oauth_dcr_rate_limit_and_max_clients(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        jwt_secret="test-secret-0123456789-abcdefghijklmnop",
        public_url=BASE,
        app_url="http://app.test",
        oauth_dcr_rate_limit_per_min=2,
        oauth_dcr_max_clients=10,
    )
    app = create_app(settings)
    client = TestClient(app)
    assert client.post("/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 201
    assert client.post("/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 201
    limited = client.post("/oauth/register", json={"redirect_uris": [REDIRECT]})
    assert limited.status_code == 429 and limited.json()["error"] == "too_many_requests"

    # 최대 클라이언트 수 한도 검증
    settings2 = Settings(
        _env_file=None,
        data_dir=tmp_path / "cap",
        jwt_secret="test-secret-0123456789-abcdefghijklmnop",
        oauth_dcr_rate_limit_per_min=100,
        oauth_dcr_max_clients=1,
    )
    client2 = TestClient(create_app(settings2))
    assert client2.post("/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 201
    assert client2.post("/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 429


def test_cimd_cache_bounded_and_mixed_dns_blocked(monkeypatch):
    # 혼합 DNS 레코드(공개 IP + 사설 IP) 차단
    def fake_getaddrinfo(host, port, type=0):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(cimd.CimdError):
        cimd._resolve_ip("rebind.example.com", 443, allow_private=False)

    # 캐시 크기 상한 검증
    monkeypatch.setattr(cimd, "_cache", {})
    monkeypatch.setattr(cimd, "MAX_CACHE_ENTRIES", 3)
    for i in range(5):
        cimd._cache_put(f"https://a.example/{i}", {"client_id": f"https://a.example/{i}"})
    assert len(cimd._cache) == 3
    assert "https://a.example/0" not in cimd._cache and "https://a.example/4" in cimd._cache


def test_sqlite_auto_migrates_legacy_json_and_fts5_search(tmp_path):
    # 1) 레거시 JSON 파일 DB에 데이터 생성
    legacy = Database.from_json_files(tmp_path)
    u = legacy.users.create(User(id="u1", email="alice@example.com", name="Alice"))
    p = legacy.projects.create(Project(key="MIG", name="이전 프로젝트", created_by=u.id, task_seq=1))
    legacy.tasks.create(Task(project_id=p.id, number=1, title="결제 게이트웨이 연동", description="토스페이먼츠 webhook 처리", created_by=u.id))
    legacy.wiki_pages.create(WikiPage(project_id=p.id, title="아키텍처", content="싱글사인온(SSO) 흐름 정리", aliases=["Arch"], created_by=u.id, updated_by=u.id))
    assert (tmp_path / "projects.json").is_file()

    # 2) SQLite 모드로 기동 → 자동 이전 + 원본 JSON 보존 + FTS5 검색 동작
    settings = Settings(_env_file=None, data_dir=tmp_path, db_backend="sqlite", jwt_secret="test-secret-0123456789-abcdefghijklmnop")
    app = create_app(settings)
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    client = login(app, "u1:alice@example.com")
    assert (tmp_path / "mightywork.db").is_file()
    assert (tmp_path / "projects.json").is_file()

    # 3글자 이상(FTS5 trigram) 및 2글자(LIKE) 검색 모두 일치
    hits3 = client.get(f"/api/projects/{p.id}/search", params={"q": "게이트웨이"}).json()
    assert len(hits3) == 1 and hits3[0]["title"] == "결제 게이트웨이 연동"
    hits2 = client.get(f"/api/projects/{p.id}/search", params={"q": "결제"}).json()
    assert len(hits2) == 1
    hits_alias = client.get(f"/api/projects/{p.id}/search", params={"q": "sso"}).json()
    assert len(hits_alias) == 1 and hits_alias[0]["title"] == "아키텍처"

    # JSON 백엔드 옵션도 여전히 정상 동작
    json_settings = Settings(_env_file=None, data_dir=tmp_path / "json_only", db_backend="json", jwt_secret="test-secret-0123456789-abcdefghijklmnop")
    json_app = create_app(json_settings)
    assert json_app.state.db._sqlite is None


def test_web_refresh_cookie_logout_and_security_headers(app):
    client = TestClient(app)
    res = client.post("/api/auth/google", json={"credential": "u1:alice@example.com"})
    assert res.status_code == 200
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "mw_refresh" in res.cookies

    # 리프레시 쿠키로 새 액세스 토큰 발급
    refreshed = client.post("/api/auth/refresh")
    assert refreshed.status_code == 200
    new_token = refreshed.json()["access_token"]
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {new_token}"}).status_code == 200

    # 로그아웃 후 쿠키가 제거되어 리프레시 실패
    assert client.post("/api/auth/logout").status_code == 204
    assert client.post("/api/auth/refresh").status_code == 401


def test_project_attachments_upload_download_isolation_and_cascade(app, auth_client, project, settings):
    pid = project["id"]
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

    up = auth_client.post(f"/api/projects/{pid}/attachments", files={"file": ("shot.png", png_bytes, "image/png")})
    assert up.status_code == 201, up.text
    att = up.json()
    assert att["url"] == f"/api/projects/{pid}/attachments/{att['id']}"

    # 다운로드 (래스터 이미지는 inline)
    dl = auth_client.get(att["url"])
    assert dl.status_code == 200 and dl.content == png_bytes
    assert dl.headers["content-disposition"].startswith("inline;")

    # HTML/SVG 업로드는 차단 (Stored XSS 방지)
    assert auth_client.post(f"/api/projects/{pid}/attachments", files={"file": ("x.svg", b"<svg/>", "image/svg+xml")}).status_code == 415
    assert auth_client.post(f"/api/projects/{pid}/attachments", files={"file": ("x.html", b"<script/>", "text/html")}).status_code == 415

    # 비멤버는 404, 보기 전용 멤버는 다운로드 가능·업로드 403
    bob = login(app, "u2:bob@example.com")
    assert bob.get(att["url"]).status_code == 404
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view"]})
    assert bob.get(att["url"]).status_code == 200
    assert bob.post(f"/api/projects/{pid}/attachments", files={"file": ("a.png", png_bytes, "image/png")}).status_code == 403

    # 프로젝트 삭제 시 첨부 파일 디렉터리도 함께 정리
    att_file = settings.data_dir / "attachments" / pid / att["id"]
    assert att_file.is_file()
    assert auth_client.delete(f"/api/projects/{pid}").status_code == 204
    assert not att_file.exists()
