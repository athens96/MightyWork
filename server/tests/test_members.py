import pytest

from tests.conftest import login


@pytest.fixture
def pid(project) -> str:
    return project["id"]


def invite(owner, pid, email, perms=None):
    body = {"email": email} if perms is None else {"email": email, "permissions": perms}
    return owner.post(f"/api/projects/{pid}/members", json=body)


def test_creator_is_owner_admin(auth_client, project):
    assert project["is_owner"] is True
    assert set(project["my_permissions"]) == {"view", "create", "edit", "delete", "admin"}
    members = auth_client.get(f"/api/projects/{project['id']}/members").json()
    assert members[0]["is_owner"] and members[0]["email"] == "alice@example.com"


def test_non_member_cannot_see_project(app, auth_client, pid):
    bob = login(app, "u2:bob@example.com")
    assert bob.get("/api/projects").json() == []
    for url in [f"/api/projects/{pid}", f"/api/projects/{pid}/tasks", f"/api/projects/{pid}/wiki/pages", f"/api/projects/{pid}/members"]:
        assert bob.get(url).status_code == 404, url  # 존재 자체를 숨김


def test_invite_before_first_login(app, auth_client, pid):
    m = invite(auth_client, pid, "  Bob@Example.com ").json()
    assert m["email"] == "bob@example.com" and m["pending"] is True and m["user"] is None
    assert m["permissions"] == ["view", "create", "edit"]  # 기본: 보기·생성·편집

    bob = login(app, "u2:bob@example.com")  # 초대 후 첫 로그인
    projects = bob.get("/api/projects").json()
    assert [p["id"] for p in projects] == [pid]
    assert projects[0]["my_permissions"] == ["view", "create", "edit"] and projects[0]["is_owner"] is False
    assert auth_client.get(f"/api/projects/{pid}/members").json()[1]["pending"] is False


def test_view_only_member(app, auth_client, pid):
    task = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "t"}).json()
    page = auth_client.post(f"/api/projects/{pid}/wiki/pages", json={"title": "p"}).json()
    invite(auth_client, pid, "bob@example.com", ["view"])
    bob = login(app, "u2:bob@example.com")

    assert bob.get(f"/api/projects/{pid}/tasks").status_code == 200
    assert bob.get(f"/api/projects/{pid}/wiki/pages/{page['id']}").status_code == 200
    assert bob.post(f"/api/projects/{pid}/tasks", json={"title": "x"}).status_code == 403
    assert bob.patch(f"/api/projects/{pid}/tasks/{task['id']}", json={"stage": "done"}).status_code == 403
    assert bob.delete(f"/api/projects/{pid}/tasks/{task['id']}").status_code == 403
    assert bob.post(f"/api/projects/{pid}/tasks/{task['id']}/comments", json={"body": "x"}).status_code == 403
    assert bob.post(f"/api/projects/{pid}/wiki/pages", json={"title": "x"}).status_code == 403
    assert bob.patch(f"/api/projects/{pid}/wiki/pages/{page['id']}", json={"content": "x"}).status_code == 403
    assert bob.post(f"/api/projects/{pid}/members", json={"email": "c@example.com"}).status_code == 403
    assert bob.patch(f"/api/projects/{pid}", json={"name": "x"}).status_code == 403


def test_create_without_edit_or_delete(app, auth_client, pid):
    invite(auth_client, pid, "bob@example.com", ["create"])
    bob = login(app, "u2:bob@example.com")
    t = bob.post(f"/api/projects/{pid}/tasks", json={"title": "bob 일감"})
    assert t.status_code == 201
    assert bob.patch(f"/api/projects/{pid}/tasks/{t.json()['id']}", json={"title": "x"}).status_code == 403
    assert bob.delete(f"/api/projects/{pid}/tasks/{t.json()['id']}").status_code == 403


def test_update_permissions_and_admin_member(app, auth_client, pid):
    m = invite(auth_client, pid, "bob@example.com", ["view"]).json()
    bob = login(app, "u2:bob@example.com")
    assert bob.post(f"/api/projects/{pid}/tasks", json={"title": "x"}).status_code == 403

    upd = auth_client.patch(f"/api/projects/{pid}/members/{m['id']}", json={"permissions": ["admin"]}).json()
    assert upd["permissions"] == ["view", "create", "edit", "delete", "admin"]  # 관리자 = 모든 권한
    assert bob.post(f"/api/projects/{pid}/tasks", json={"title": "x"}).status_code == 201
    # 관리자 멤버는 다른 멤버를 관리할 수 있지만 프로젝트 삭제는 소유자만
    assert invite(bob, pid, "carol@example.com").status_code == 201
    assert bob.delete(f"/api/projects/{pid}").status_code == 403


def test_owner_is_protected_and_duplicates_rejected(auth_client, pid):
    assert auth_client.patch(f"/api/projects/{pid}/members/owner", json={"permissions": ["view"]}).status_code == 400
    assert auth_client.delete(f"/api/projects/{pid}/members/owner").status_code == 400
    assert invite(auth_client, pid, "alice@example.com").status_code == 409  # 소유자 본인
    invite(auth_client, pid, "bob@example.com")
    assert invite(auth_client, pid, "BOB@example.com").status_code == 409
    assert invite(auth_client, pid, "not-an-email").status_code == 422


def test_assignee_must_be_member_and_cleared_on_removal(app, auth_client, pid):
    login(app, "u2:bob@example.com")  # 로그인은 했지만 멤버 아님
    t = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "t"}).json()
    url = f"/api/projects/{pid}/tasks/{t['id']}"
    assert auth_client.patch(url, json={"assignee_id": "u2"}).status_code == 400

    m = invite(auth_client, pid, "bob@example.com").json()
    assert auth_client.patch(url, json={"assignee_id": "u2"}).json()["assignee_id"] == "u2"

    assert auth_client.delete(f"/api/projects/{pid}/members/{m['id']}").status_code == 204
    assert auth_client.get(url).json()["assignee_id"] is None  # 제거되면 미지정
    bob = login(app, "u2:bob@example.com")
    assert bob.get(f"/api/projects/{pid}").status_code == 404  # 접근 불가


def test_admin_can_delete_others_comment(app, auth_client, pid):
    t = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "t"}).json()
    invite(auth_client, pid, "bob@example.com")
    bob = login(app, "u2:bob@example.com")
    c = bob.post(f"/api/projects/{pid}/tasks/{t['id']}/comments", json={"body": "bob"}).json()
    curl = f"/api/projects/{pid}/tasks/{t['id']}/comments/{c['id']}"
    assert auth_client.patch(curl, json={"body": "x"}).status_code == 403  # 수정은 작성자만
    assert auth_client.delete(curl).status_code == 204  # 삭제는 관리자도 가능


def test_project_delete_removes_members(app, auth_client, pid):
    invite(auth_client, pid, "bob@example.com")
    auth_client.delete(f"/api/projects/{pid}")
    assert app.state.db.project_members.list() == []
