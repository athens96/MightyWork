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
