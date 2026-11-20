def test_wiki_tree_crud(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    root = auth_client.post(base, json={"title": "개발 가이드", "content": "# Hello"}).json()
    child = auth_client.post(base, json={"title": "코딩 컨벤션", "parent_id": root["id"]}).json()
    assert root["project_id"] == project["id"]

    summaries = auth_client.get(base).json()
    assert {s["id"] for s in summaries} == {root["id"], child["id"]}
    assert "content" not in summaries[0]

    updated = auth_client.patch(f"{base}/{root['id']}", json={"content": "# Updated"}).json()
    assert updated["content"] == "# Updated"

    # 자식이 있으면 삭제 불가
    assert auth_client.delete(f"{base}/{root['id']}").status_code == 409
    # 자식을 루트로 이동 후 삭제 가능
    assert auth_client.patch(f"{base}/{child['id']}", json={"parent_id": None}).json()["parent_id"] is None
    assert auth_client.delete(f"{base}/{root['id']}").status_code == 204


def test_wiki_rejects_cycles_and_missing_parent(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    a = auth_client.post(base, json={"title": "A"}).json()
    b = auth_client.post(base, json={"title": "B", "parent_id": a["id"]}).json()

    assert auth_client.patch(f"{base}/{a['id']}", json={"parent_id": b["id"]}).status_code == 400
    assert auth_client.patch(f"{base}/{a['id']}", json={"parent_id": a["id"]}).status_code == 400
    assert auth_client.post(base, json={"title": "C", "parent_id": "nope"}).status_code == 400


def test_wiki_isolated_between_projects(auth_client, project):
    page = auth_client.post(f"/api/projects/{project['id']}/wiki/pages", json={"title": "A"}).json()
    other = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    other_base = f"/api/projects/{other['id']}/wiki/pages"

    assert auth_client.get(other_base).json() == []
    assert auth_client.get(f"{other_base}/{page['id']}").status_code == 404
    # 다른 프로젝트의 페이지를 부모로 지정할 수 없음
    assert auth_client.post(other_base, json={"title": "B", "parent_id": page["id"]}).status_code == 400


# ---------------------------------------------------------------- Properties

from tests.conftest import login


def test_page_properties_and_filters(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    g = auth_client.post(base, json={"title": "온보딩 가이드", "page_type": "guide", "status": "published", "owner_id": "u1", "tags": [" onboarding ", "Onboarding", "팀"]}).json()
    assert (g["page_type"], g["status"], g["owner_id"], g["tags"]) == ("guide", "published", "u1", ["onboarding", "팀"])
    d = auth_client.post(base, json={"title": "DB 선택", "page_type": "decision", "status": "review", "tags": ["db"]}).json()
    auth_client.post(base, json={"title": "미분류 메모"})

    titles = lambda **params: [p["title"] for p in auth_client.get(base, params=params).json()]
    assert titles(page_type="decision") == ["DB 선택"]
    assert titles(status="published") == ["온보딩 가이드"]
    assert titles(tag="ONBOARDING") == ["온보딩 가이드"]  # 대소문자 무시
    assert titles(owner_id="u1") == ["온보딩 가이드"]
    assert len(titles()) == 3
    assert auth_client.get(base).json()[0]["tags"] == ["onboarding", "팀"]  # 목록에 Properties 포함

    upd = auth_client.patch(f"{base}/{d['id']}", json={"status": "published", "page_type": None}).json()
    assert (upd["status"], upd["page_type"]) == ("published", None)
    assert auth_client.patch(f"{base}/{d['id']}", json={"status": "unknown"}).status_code == 422


def test_owner_must_be_member_and_cleared_on_removal(app, auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    login(app, "u2:bob@example.com")
    assert auth_client.post(base, json={"title": "x", "owner_id": "u2"}).status_code == 400
    m = auth_client.post(f"/api/projects/{project['id']}/members", json={"email": "bob@example.com"}).json()
    p = auth_client.post(base, json={"title": "x", "owner_id": "u2"}).json()
    assert p["owner_id"] == "u2"
    auth_client.delete(f"/api/projects/{project['id']}/members/{m['id']}")
    assert auth_client.get(f"{base}/{p['id']}").json()["owner_id"] is None


def test_search_matches_page_tags(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    p = auth_client.post(base, json={"title": "배포 절차", "tags": ["devops"]}).json()
    hits = auth_client.get(f"/api/projects/{project['id']}/search", params={"q": "devops"}).json()
    assert hits[0]["id"] == p["id"]
