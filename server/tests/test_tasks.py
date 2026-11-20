def test_pipeline(auth_client):
    stages = [s["key"] for s in auth_client.get("/api/pipeline").json()]
    assert stages[0] == "backlog" and stages[-1] == "done"


def test_task_crud_and_stage_move(auth_client, project):
    base = f"/api/projects/{project['id']}/tasks"
    res = auth_client.post(base, json={"title": "로그인 구현", "priority": "high"})
    assert res.status_code == 201
    task = res.json()
    assert task["stage"] == "backlog"
    assert task["created_by"] == "u1"
    assert task["project_id"] == project["id"]

    moved = auth_client.patch(f"{base}/{task['id']}", json={"stage": "in_progress"}).json()
    assert moved["stage"] == "in_progress"
    assert moved["title"] == "로그인 구현"  # 보내지 않은 필드는 유지

    assert len(auth_client.get(base, params={"stage": "in_progress"}).json()) == 1
    assert auth_client.get(base, params={"stage": "done"}).json() == []

    assert auth_client.delete(f"{base}/{task['id']}").status_code == 204
    assert auth_client.get(f"{base}/{task['id']}").status_code == 404


def test_task_numbers_are_sequential_per_project_and_not_reused(auth_client, project):
    base = f"/api/projects/{project['id']}/tasks"
    t1 = auth_client.post(base, json={"title": "a"}).json()
    t2 = auth_client.post(base, json={"title": "b"}).json()
    assert (t1["number"], t2["number"]) == (1, 2)

    auth_client.delete(f"{base}/{t2['id']}")
    assert auth_client.post(base, json={"title": "c"}).json()["number"] == 3

    other = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    assert auth_client.post(f"/api/projects/{other['id']}/tasks", json={"title": "x"}).json()["number"] == 1

    # 프로젝트 이름 수정이 발급된 번호를 되돌리지 않음
    auth_client.patch(f"/api/projects/{project['id']}", json={"name": "renamed"})
    assert auth_client.post(base, json={"title": "d"}).json()["number"] == 4


def test_tasks_are_isolated_between_projects(auth_client, project):
    task = auth_client.post(f"/api/projects/{project['id']}/tasks", json={"title": "mine"}).json()
    other = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    other_base = f"/api/projects/{other['id']}/tasks"

    assert auth_client.get(other_base).json() == []
    assert auth_client.get(f"{other_base}/{task['id']}").status_code == 404
    assert auth_client.patch(f"{other_base}/{task['id']}", json={"stage": "done"}).status_code == 404
    assert auth_client.delete(f"{other_base}/{task['id']}").status_code == 404


def test_patch_rejects_null_title(auth_client, project):
    base = f"/api/projects/{project['id']}/tasks"
    task = auth_client.post(base, json={"title": "t"}).json()
    assert auth_client.patch(f"{base}/{task['id']}", json={"title": None}).status_code == 422
