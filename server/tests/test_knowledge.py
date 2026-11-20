import pytest

from app.services.links import link_targets, rename_links, task_numbers
from tests.conftest import login


def test_link_parsing_ignores_code_and_dedupes():
    md = "보기 [[개발 가이드]] 와 [[개발  가이드|가이드]], [[API 규칙]]\n`[[코드 안]]`\n```\n[[블록 안]] MW-9\n```\nMW-3, MW-3, XMW-4, MW-12x"
    assert link_targets(md) == ["개발 가이드", "API 규칙"]
    assert task_numbers(md, "MW") == [3]


def test_rename_links_keeps_alias():
    md = "[[Old Page]] / [[old  page|별칭]] / [[Other]]"
    assert rename_links(md, "Old Page", "New") == "[[New]] / [[New|별칭]] / [[Other]]"


@pytest.fixture
def pid(project) -> str:
    return project["id"]


def page(client, pid, title, content="", parent_id=None):
    return client.post(f"/api/projects/{pid}/wiki/pages", json={"title": title, "content": content, "parent_id": parent_id}).json()


def test_outgoing_backlinks_and_task_mentions(auth_client, pid):
    t1 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "로그인"}).json()  # MW-1
    guide = page(auth_client, pid, "개발 가이드", "규칙은 [[코딩 컨벤션]] 참고. 없는 [[미작성 문서]]. 관련 일감 MW-1, MW-99")
    conv = page(auth_client, pid, "코딩 컨벤션", "[[개발 가이드]] 로 돌아가기")
    page(auth_client, pid, "무관", "링크 없음")

    links = auth_client.get(f"/api/projects/{pid}/wiki/pages/{guide['id']}/links").json()
    assert links["outgoing"] == [{"title": "코딩 컨벤션", "page_id": conv["id"]}, {"title": "미작성 문서", "page_id": None}]
    assert [b["title"] for b in links["backlinks"]] == ["코딩 컨벤션"]
    assert [t["number"] for t in links["tasks"]] == [1] and links["missing_tasks"] == [99]

    refs = auth_client.get(f"/api/projects/{pid}/tasks/{t1['id']}/wiki-refs").json()
    assert [r["title"] for r in refs] == ["개발 가이드"]


def test_rename_updates_links_in_pages_and_task_descriptions(auth_client, pid):
    target = page(auth_client, pid, "API 규칙")
    src = page(auth_client, pid, "개요", "[[API 규칙]] 과 [[api 규칙|규칙]]")
    t = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "x", "description": "참고: [[API 규칙]]"}).json()

    auth_client.patch(f"/api/projects/{pid}/wiki/pages/{target['id']}", json={"title": "REST API 규칙"})
    assert auth_client.get(f"/api/projects/{pid}/wiki/pages/{src['id']}").json()["content"] == "[[REST API 규칙]] 과 [[REST API 규칙|규칙]]"
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t['id']}").json()["description"] == "참고: [[REST API 규칙]]"
    links = auth_client.get(f"/api/projects/{pid}/wiki/pages/{src['id']}/links").json()
    assert links["outgoing"][0]["page_id"] == target["id"]


def test_links_do_not_cross_projects(auth_client, pid):
    other = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    page(auth_client, other["id"], "비밀 문서")
    src = page(auth_client, pid, "개요", "[[비밀 문서]]")
    links = auth_client.get(f"/api/projects/{pid}/wiki/pages/{src['id']}/links").json()
    assert links["outgoing"] == [{"title": "비밀 문서", "page_id": None}]  # 다른 프로젝트 문서로 연결되지 않음


def test_search_ranks_title_over_body_and_finds_by_key(auth_client, pid):
    a = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "결제 모듈", "tags": ["pay"]}).json()  # MW-1
    b = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "기타", "description": "결제 화면 문구 수정"}).json()
    c = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "덧글로만"}).json()
    auth_client.post(f"/api/projects/{pid}/tasks/{c['id']}/comments", json={"body": "결제 쪽 영향 있음"})
    w = page(auth_client, pid, "결제 설계", "## 결제 흐름\n결제는 ...")

    hits = auth_client.get(f"/api/projects/{pid}/search", params={"q": "결제"}).json()
    ids = [h["id"] for h in hits]
    assert set(ids) == {a["id"], b["id"], c["id"], w["id"]}
    assert ids.index(a["id"]) < ids.index(b["id"]) and ids.index(w["id"]) < ids.index(b["id"])
    assert "결제" in next(h for h in hits if h["id"] == b["id"])["snippet"]

    by_key = auth_client.get(f"/api/projects/{pid}/search", params={"q": "mw-1"}).json()
    assert by_key[0]["id"] == a["id"] and by_key[0]["number"] == 1
    assert auth_client.get(f"/api/projects/{pid}/search", params={"q": ""}).status_code == 422


def test_knowledge_endpoints_require_membership(app, auth_client, pid):
    p = page(auth_client, pid, "문서")
    bob = login(app, "u2:bob@example.com")
    assert bob.get(f"/api/projects/{pid}/search", params={"q": "문서"}).status_code == 404
    assert bob.get(f"/api/projects/{pid}/wiki/pages/{p['id']}/links").status_code == 404
