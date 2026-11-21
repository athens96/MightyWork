"""P0 백로그(MW-1 ~ MW-5) 백엔드 테스트."""

from tests.conftest import login


def test_mw1_saved_views_crud_and_permissions(app, auth_client, project):
    pid = project["id"]
    url = f"/api/projects/{pid}/views"

    created = auth_client.post(
        url,
        json={"name": "긴급 버그", "layout": "list", "filters": {"priority": "urgent", "tag": "bug"}},
    )
    assert created.status_code == 201, created.text
    v = created.json()
    assert v["name"] == "긴급 버그" and v["layout"] == "list" and v["filters"]["priority"] == "urgent"
    assert [x["id"] for x in auth_client.get(url).json()] == [v["id"]]

    # 보기 전용 멤버는 생성/삭제 불가, 조회는 가능
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view"]})
    bob = login(app, "u2:bob@example.com")
    assert len(bob.get(url).json()) == 1
    assert bob.post(url, json={"name": "x", "layout": "board", "filters": {}}).status_code == 403
    assert bob.delete(f"{url}/{v['id']}").status_code == 403

    # 작성자/관리자는 삭제 가능
    assert auth_client.delete(f"{url}/{v['id']}").status_code == 204
    assert auth_client.get(url).json() == []


def test_mw2_my_tasks_cross_project_and_isolation(app, auth_client, project):
    from datetime import date, timedelta

    p1 = project
    p2 = auth_client.post("/api/projects", json={"key": "MC", "name": "MightyCode"}).json()
    bob = login(app, "u2:bob@example.com")
    # bob 이 만든 비공개 프로젝트의 일감은 alice 에게 절대 노출되지 않아야 함
    bob_proj = bob.post("/api/projects", json={"key": "SEC", "name": "Secret"}).json()
    bob.post(f"/api/projects/{bob_proj['id']}/tasks", json={"title": "비밀", "assignee_id": "u2"})

    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    later = (date.today() + timedelta(days=10)).isoformat()
    auth_client.post(f"/api/projects/{p1['id']}/tasks", json={"title": "긴급 마감", "assignee_id": "u1", "due_date": tomorrow})
    auth_client.post(f"/api/projects/{p2['id']}/tasks", json={"title": "여유 작업", "assignee_id": "u1", "due_date": later})
    auth_client.post(f"/api/projects/{p1['id']}/tasks", json={"title": "완료 작업", "assignee_id": "u1", "stage": "done"})
    auth_client.post(f"/api/projects/{p1['id']}/tasks", json={"title": "미배정 내가만듦"})

    assigned = auth_client.get("/api/my/tasks").json()
    assert [t["title"] for t in assigned] == ["긴급 마감", "여유 작업"]
    assert {t["project_key"] for t in assigned} == {"MW", "MC"}

    soon = auth_client.get("/api/my/tasks", params={"due_soon": True}).json()
    assert [t["title"] for t in soon] == ["긴급 마감"]

    with_done = auth_client.get("/api/my/tasks", params={"include_done": True}).json()
    assert len(with_done) == 3

    created = auth_client.get("/api/my/tasks", params={"scope": "created"}).json()
    assert any(t["title"] == "미배정 내가만듦" for t in created)
    assert all(t["project_key"] != "SEC" for t in created)
