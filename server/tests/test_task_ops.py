from tests.conftest import login


def test_task_duplicate_resets_checklist_and_copies_fields(auth_client, project):
    base = f"/api/projects/{project['id']}/tasks"
    src = auth_client.post(
        base,
        json={
            "title": "결제 모듈 리팩터링",
            "description": "상세 설명",
            "stage": "in_progress",
            "priority": "high",
            "version": "v0.6.0",
            "tags": ["backend", "billing"],
            "estimate": 5,
            "checklist": [{"text": "인터페이스 정의", "done": True}, {"text": "테스트 작성", "done": False}],
        },
    ).json()

    dup = auth_client.post(f"{base}/{src['id']}/duplicate")
    assert dup.status_code == 201
    d = dup.json()
    assert d["id"] != src["id"]
    assert d["number"] == src["number"] + 1
    assert d["title"] == "결제 모듈 리팩터링 (복사)"
    assert (d["description"], d["stage"], d["priority"], d["version"], d["tags"], d["estimate"]) == (
        "상세 설명",
        "in_progress",
        "high",
        "v0.6.0",
        ["backend", "billing"],
        5,
    )
    assert [i["text"] for i in d["checklist"]] == ["인터페이스 정의", "테스트 작성"]
    assert all(i["done"] is False for i in d["checklist"])
    assert d["checklist"][0]["id"] != src["checklist"][0]["id"]


def test_task_move_between_projects_and_permissions(app, auth_client, project):
    other = auth_client.post("/api/projects", json={"key": "OT", "name": "Other"}).json()
    base = f"/api/projects/{project['id']}/tasks"
    other_base = f"/api/projects/{other['id']}/tasks"

    parent = auth_client.post(base, json={"title": "상위"}).json()
    task = auth_client.post(base, json={"title": "이동할 일감", "parent_id": parent["id"], "tags": ["ops"]}).json()
    child = auth_client.post(base, json={"title": "하위", "parent_id": task["id"]}).json()
    auth_client.post(f"{base}/{task['id']}/links", json={"target_id": parent["id"], "kind": "relates_to"})
    cmt = auth_client.post(f"{base}/{task['id']}/comments", json={"body": "이전될 덧글"}).json()

    # 같은 프로젝트로 이동 불가
    assert auth_client.post(f"{base}/{task['id']}/move", json={"target_project_id": project["id"]}).status_code == 400

    # 대상 프로젝트 생성 권한 없는 멤버는 403
    bob = login(app, "u2:bob@example.com")
    auth_client.post(f"/api/projects/{project['id']}/members", json={"email": "bob@example.com", "permissions": ["view", "create", "edit", "delete"]})
    auth_client.post(f"/api/projects/{other['id']}/members", json={"email": "bob@example.com", "permissions": ["view"]})
    assert bob.post(f"{base}/{task['id']}/move", json={"target_project_id": other["id"]}).status_code == 403

    # 정상 이동
    moved_res = auth_client.post(f"{base}/{task['id']}/move", json={"target_project_id": other["id"]})
    assert moved_res.status_code == 200
    moved = moved_res.json()
    assert moved["project_id"] == other["id"]
    assert moved["number"] == 1
    assert moved["parent_id"] is None

    # 원래 프로젝트에서 제거되고 대상 프로젝트에 존재
    assert auth_client.get(f"{base}/{task['id']}").status_code == 404
    assert auth_client.get(f"{other_base}/{task['id']}").status_code == 200
    # 덧글 이전, 하위 일감 분리, 교차 프로젝트 링크 정리
    other_comments = auth_client.get(f"{other_base}/{task['id']}/comments").json()
    assert [c["id"] for c in other_comments] == [cmt["id"]]
    assert auth_client.get(f"{base}/{child['id']}").json()["parent_id"] is None
    assert auth_client.get(f"{other_base}/{task['id']}/links").json() == []


def test_blocked_by_count_tracks_unfinished_blockers(auth_client, project):
    base = f"/api/projects/{project['id']}/tasks"
    blocker = auth_client.post(base, json={"title": "선행 작업", "stage": "in_progress"}).json()
    blocked = auth_client.post(base, json={"title": "후속 작업", "stage": "todo"}).json()

    assert auth_client.get(f"{base}/{blocked['id']}").json()["blocked_by_count"] == 0

    auth_client.post(f"{base}/{blocker['id']}/links", json={"target_id": blocked["id"], "kind": "blocks"})
    assert auth_client.get(f"{base}/{blocked['id']}").json()["blocked_by_count"] == 1
    listed = {t["id"]: t for t in auth_client.get(base).json()}
    assert listed[blocked["id"]]["blocked_by_count"] == 1
    assert listed[blocker["id"]]["blocked_by_count"] == 0

    # 선행 작업이 done 이 되면 차단 카운트가 0 으로 내려감
    auth_client.patch(f"{base}/{blocker['id']}", json={"stage": "done"})
    assert auth_client.get(f"{base}/{blocked['id']}").json()["blocked_by_count"] == 0
    listed2 = {t["id"]: t for t in auth_client.get(base).json()}
    assert listed2[blocked["id"]]["blocked_by_count"] == 0
