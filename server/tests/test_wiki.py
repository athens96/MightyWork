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
