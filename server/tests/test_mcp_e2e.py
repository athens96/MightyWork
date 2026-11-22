"""MCP 엔드투엔드: 실제 uvicorn 서버 + MCP SDK 의 OAuthClientProvider.

401 → Protected Resource Metadata → 인가 서버 메타데이터 → 동적 등록 → 인가(동의) → 토큰(PKCE·iss 검증) → 도구 호출.
"""

import socket
import threading
import time
from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
import uvicorn
from pydantic import AnyUrl

from mcp import Client
from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

from app.api.deps import get_google_verifier
from app.core.config import Settings
from app.main import create_app
from tests.conftest import fake_verifier

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def server(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    app = create_app(Settings(_env_file=None, data_dir=tmp_path, jwt_secret="test-secret-0123456789-abcdefghijklmnop", public_url=base, app_url="http://app.test"))
    app.dependency_overrides[get_google_verifier] = lambda: fake_verifier
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield base
    srv.should_exit = True
    thread.join(5)


def app_login(base: str, credential: str) -> str:
    with httpx2.Client(base_url=base) as c:
        return c.post("/api/auth/google", json={"credential": credential}).json()["access_token"]


class MemoryStorage:
    def __init__(self):
        self.tokens: OAuthToken | None = None
        self.client_info: OAuthClientInformationFull | None = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens

    async def get_client_info(self):
        return self.client_info

    async def set_client_info(self, info):
        self.client_info = info


def provider(base: str, user_token: str, scopes: list[str] | None = None) -> OAuthClientProvider:
    """브라우저 대신: 인가 URL → 동의 화면 요청 id → 사용자(웹 앱 토큰)로 승인 → 돌아온 code/state/iss."""
    landed: dict[str, str] = {}

    async def redirect_handler(url: str) -> None:
        async with httpx2.AsyncClient(base_url=base, follow_redirects=False) as c:
            res = await c.get(url)
            assert res.status_code == 302, res.text
            rid = parse_qs(urlsplit(res.headers["location"]).query)["request"][0]
            h = {"Authorization": f"Bearer {user_token}"}
            info = (await c.get(f"/api/oauth/requests/{rid}", headers=h)).json()
            decision = await c.post(f"/api/oauth/requests/{rid}/decision", json={"approve": True, "scopes": scopes or info["requested_scopes"]}, headers=h)
            landed["url"] = decision.json()["redirect_to"]

    async def callback_handler() -> AuthorizationCodeResult:
        q = parse_qs(urlsplit(landed["url"]).query)
        return AuthorizationCodeResult(code=q["code"][0], state=q["state"][0], iss=q.get("iss", [None])[0])

    return OAuthClientProvider(
        server_url=f"{base}/mcp",
        client_metadata=OAuthClientMetadata(client_name="E2E 에이전트", redirect_uris=[AnyUrl("http://127.0.0.1:45555/callback")], application_type="native"),
        storage=MemoryStorage(),
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )


async def connect(base: str, auth: OAuthClientProvider):
    http = httpx2.AsyncClient(auth=auth, timeout=httpx2.Timeout(30.0))
    return http, Client(streamable_http_client(f"{base}/mcp", http_client=http))


async def call(client: Client, name: str, args: dict):
    res = await client.call_tool(name, args)
    return res


def text(res) -> str:
    return " ".join(getattr(c, "text", "") for c in res.content)


async def test_oauth_flow_and_tools(server):
    alice = app_login(server, "u1:alice@example.com")
    with httpx2.Client(base_url=server, headers={"Authorization": f"Bearer {alice}"}) as api:
        api.post("/api/projects", json={"key": "MW", "name": "MightyWork"})

    http, client = await connect(server, provider(server, alice))
    async with http, client:
        assert client.protocol_version == "2026-07-28"
        tools = {t.name for t in (await client.list_tools()).tools}
        assert {"list_projects", "create_task", "get_wiki_page", "search"} <= tools

        projects = (await call(client, "list_projects", {})).structured_content["result"]
        assert projects[0]["key"] == "MW" and "admin" in projects[0]["my_permissions"]

        created = (await call(client, "create_task", {"project": "MW", "title": "MCP 로 만든 일감", "description": "에이전트가 작성", "checklist": ["설계", "구현"], "tags": ["mcp"]})).structured_content
        assert created["key"] == "MW-1" and created["checklist"] == [{"text": "설계", "done": False}, {"text": "구현", "done": False}]

        moved = (await call(client, "update_task", {"project": "MW", "task": "MW-1", "stage": "in_progress", "check_items": ["설계"], "assignee_email": "alice@example.com"})).structured_content
        assert moved["stage"] == "in_progress" and moved["assignee"] == "alice@example.com" and moved["checklist"][0]["done"] is True

        await call(client, "add_comment", {"project": "MW", "task": "MW-1", "body": "진행 상황 공유"})
        detail = (await call(client, "get_task", {"project": "MW", "task": "1"})).structured_content
        assert detail["comments"][0]["body"] == "진행 상황 공유" and detail["comments"][0]["author"] == "alice@example.com"

        page = (await call(client, "create_wiki_page", {"project": "MW", "title": "MCP 가이드", "content": "관련 일감 MW-1", "tags": ["mcp"], "page_type": "guide"})).structured_content
        await call(client, "update_wiki_page", {"project": "MW", "page": "MCP 가이드", "append": "## 추가\n덧붙인 내용"})
        got = (await call(client, "get_wiki_page", {"project": "MW", "page": page["id"]})).structured_content
        assert got["content"].endswith("## 추가\n덧붙인 내용") and got["type"] == "guide"

        hits = (await call(client, "search", {"project": "MW", "query": "MCP"})).structured_content["result"]
        assert {h["kind"] for h in hits} == {"task", "wiki"}

        # 신규 도구: 하위 일감 + 일감 링크 + 용어집/그래프 Q&A + 사이클·마일스톤·릴리즈(MW-20)
        sub = (await call(client, "create_task", {"project": "MW", "title": "하위 작업", "parent": "MW-1"})).structured_content
        assert sub["key"] == "MW-2"
        linked = (await call(client, "link_tasks", {"project": "MW", "source_task": "MW-1", "target_task": "MW-2", "kind": "blocks"})).structured_content
        assert linked["kind"] == "blocks"
        qa = (await call(client, "ask_knowledge_graph", {"project": "MW", "question": "MCP 가이드가 무엇인가요?"})).structured_content
        assert "MCP 가이드" in qa["answer"]

        cyc = (await call(client, "create_cycle", {"project": "MW", "name": "2026-11", "start_date": "2026-11-01", "end_date": "2026-11-30", "status": "active"})).structured_content
        ms = (await call(client, "create_milestone", {"project": "MW", "name": "v0.2 출시", "status": "active"})).structured_content
        assert cyc["name"] == "2026-11" and ms["name"] == "v0.2 출시"

        updated_meta = (await call(client, "update_task", {"project": "MW", "task": "MW-1", "version": "v0.2.0", "cycle": "2026-11", "milestone": "v0.2 출시", "stage": "done"})).structured_content
        assert updated_meta["version"] == "v0.2.0" and updated_meta["cycle"] == "2026-11" and updated_meta["milestone"] == "v0.2 출시"

        by_cycle = (await call(client, "list_tasks", {"project": "MW", "cycle": "2026-11", "version": "v0.2.0"})).structured_content
        assert by_cycle["total"] == 1 and by_cycle["tasks"][0]["key"] == "MW-1"

        cycs = (await call(client, "list_cycles", {"project": "MW"})).structured_content["result"]
        assert cycs[0]["name"] == "2026-11" and cycs[0]["done_tasks"] == 1
        mss = (await call(client, "list_milestones", {"project": "MW"})).structured_content["result"]
        assert mss[0]["name"] == "v0.2 출시" and mss[0]["progress_pct"] == 100
        rels = (await call(client, "list_releases", {"project": "MW", "version": "v0.2.0", "include_changelog": True})).structured_content
        assert rels["releases"][0]["version"] == "v0.2.0" and "MW-1" in rels["changelog"]

        missing = await call(client, "get_task", {"project": "NOPE", "task": "1"})
        assert missing.is_error and "접근 권한" in text(missing)

    # 웹 앱에서도 같은 데이터가 보이고, '연결된 앱'에 등록되며 MCP 출처(via_client)가 남음 (MW-13)
    with httpx2.Client(base_url=server, headers={"Authorization": f"Bearer {alice}"}) as api:
        pid = api.get("/api/projects").json()[0]["id"]
        tasks_list = api.get(f"/api/projects/{pid}/tasks").json()
        assert tasks_list[0]["title"] == "MCP 로 만든 일감"
        assert tasks_list[0]["via_client"] == "E2E 에이전트"
        t_id = tasks_list[0]["id"]
        assert api.get(f"/api/projects/{pid}/tasks/{t_id}/comments").json()[0]["via_client"] == "E2E 에이전트"
        assert all(a["via_client"] == "E2E 에이전트" for a in api.get(f"/api/projects/{pid}/tasks/{t_id}/activity").json())
        pages_list = api.get(f"/api/projects/{pid}/wiki/pages").json()
        revs = api.get(f"/api/projects/{pid}/wiki/pages/{pages_list[0]['id']}/revisions").json()
        assert revs and all(r["via_client"] == "E2E 에이전트" for r in revs)
        assert [g["client_name"] for g in api.get("/api/oauth/grants").json()] == ["E2E 에이전트"]


async def test_read_only_grant_and_project_permissions(server):
    alice = app_login(server, "u1:alice@example.com")
    bob = app_login(server, "u2:bob@example.com")
    with httpx2.Client(base_url=server, headers={"Authorization": f"Bearer {alice}"}) as api:
        pid = api.post("/api/projects", json={"key": "MW", "name": "MightyWork"}).json()["id"]
        api.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view"]})
        api.post(f"/api/projects/{pid}/tasks", json={"title": "기존 일감"})
        api.post("/api/projects", json={"key": "SECRET", "name": "비공개"})

    # 1) 읽기만 허용한 연결 → 쓰기 도구 거부
    http, client = await connect(server, provider(server, alice, scopes=["mightywork:read"]))
    async with http, client:
        assert (await call(client, "get_task", {"project": "MW", "task": "MW-1"})).structured_content["title"] == "기존 일감"
        res = await call(client, "create_task", {"project": "MW", "title": "x"})
        assert res.is_error and "쓰기 권한" in text(res)

    # 2) 쓰기 scope 가 있어도 프로젝트 권한이 보기뿐이면 거부, 멤버가 아닌 프로젝트는 보이지 않음
    http, client = await connect(server, provider(server, bob))
    async with http, client:
        keys = [p["key"] for p in (await call(client, "list_projects", {})).structured_content["result"]]
        assert keys == ["MW"]
        res = await call(client, "create_task", {"project": "MW", "title": "x"})
        assert res.is_error and "'create' 권한이 없습니다" in text(res)
        res = await call(client, "list_tasks", {"project": "SECRET"})
        assert res.is_error
