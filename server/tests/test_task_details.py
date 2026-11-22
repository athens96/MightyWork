import pytest

from tests.conftest import login


@pytest.fixture
def base(project) -> str:
    return f"/api/projects/{project['id']}/tasks"


@pytest.fixture
def task(auth_client, base) -> dict:
    return auth_client.post(base, json={"title": "상세 일감"}).json()


def test_detail_fields_and_dates(auth_client, base):
    res = auth_client.post(
        base,
        json={
            "title": "로그인",
            "assignee_id": "u1",
            "start_date": "2026-11-20",
            "due_date": "2026-11-30",
            "estimate": 3,
            "tags": ["auth"],
            "checklist": [{"text": "구글 콘솔 설정"}, {"text": "토큰 검증", "done": True}],
        },
    )
    assert res.status_code == 201, res.text
    t = res.json()
    assert (t["start_date"], t["due_date"], t["estimate"]) == ("2026-11-20", "2026-11-30", 3)
    assert [i["done"] for i in t["checklist"]] == [False, True]
    assert all(i["id"] for i in t["checklist"])  # 항목 id 자동 발급
    assert t["comment_count"] == 0


def test_start_must_not_be_after_due(auth_client, base, task):
    assert auth_client.post(base, json={"title": "x", "start_date": "2026-12-02", "due_date": "2026-12-01"}).status_code == 422
    auth_client.patch(f"{base}/{task['id']}", json={"due_date": "2026-12-01"})
    # 기존 종료일보다 늦은 시작일로 수정하면 거부
    assert auth_client.patch(f"{base}/{task['id']}", json={"start_date": "2026-12-05"}).status_code == 422


def test_assignee_must_exist_and_can_be_cleared(auth_client, base, task):
    url = f"{base}/{task['id']}"
    assert auth_client.patch(url, json={"assignee_id": "ghost"}).status_code == 400
    assert auth_client.patch(url, json={"assignee_id": "u1"}).json()["assignee_id"] == "u1"
    assert auth_client.patch(url, json={"assignee_id": None}).json()["assignee_id"] is None


def test_checklist_replace_keeps_ids(auth_client, base, task):
    url = f"{base}/{task['id']}"
    items = auth_client.patch(url, json={"checklist": [{"text": "a"}, {"text": "b"}]}).json()["checklist"]
    items[0]["done"] = True
    updated = auth_client.patch(url, json={"checklist": items}).json()["checklist"]
    assert [(i["id"], i["done"]) for i in updated] == [(items[0]["id"], True), (items[1]["id"], False)]
    assert auth_client.patch(url, json={"checklist": [{"text": ""}]}).status_code == 422


def test_comments_crud_and_count(auth_client, base, task):
    url = f"{base}/{task['id']}/comments"
    c = auth_client.post(url, json={"body": "**확인** 부탁드립니다"}).json()
    assert c["author_id"] == "u1"
    auth_client.post(url, json={"body": "두 번째"})

    assert [x["body"] for x in auth_client.get(url).json()] == ["**확인** 부탁드립니다", "두 번째"]
    assert auth_client.get(f"{base}/{task['id']}").json()["comment_count"] == 2
    assert auth_client.get(base).json()[0]["comment_count"] == 2

    assert auth_client.patch(f"{url}/{c['id']}", json={"body": "수정됨"}).json()["body"] == "수정됨"
    assert auth_client.delete(f"{url}/{c['id']}").status_code == 204
    assert len(auth_client.get(url).json()) == 1
    assert auth_client.post(url, json={"body": ""}).status_code == 422


def test_only_author_can_edit_comment(app, auth_client, project, base, task):
    url = f"{base}/{task['id']}/comments"
    c = auth_client.post(url, json={"body": "내 덧글"}).json()

    auth_client.post(f"/api/projects/{project['id']}/members", json={"email": "bob@example.com"})
    other = login(app, "u2:bob@example.com")
    assert other.patch(f"{url}/{c['id']}", json={"body": "남의 덧글"}).status_code == 403
    assert other.delete(f"{url}/{c['id']}").status_code == 403
    assert other.post(url, json={"body": "bob 덧글"}).status_code == 201  # 작성은 누구나


def test_activity_records_tracked_changes(auth_client, base, task):
    url = f"{base}/{task['id']}"
    auth_client.patch(url, json={"stage": "in_progress", "assignee_id": "u1"})
    auth_client.patch(url, json={"description": "설명만 수정"})  # 이력 제외 필드

    acts = auth_client.get(f"{url}/activity").json()
    assert acts[0]["kind"] == "created"
    changes = {(a["field"], a["old"], a["new"]) for a in acts[1:]}
    assert changes == {("stage", "backlog", "in_progress"), ("assignee_id", None, "u1")}
    assert all(a["actor_id"] == "u1" for a in acts)


def test_comments_are_scoped_to_task_and_project(auth_client, base, task):
    other_task = auth_client.post(base, json={"title": "다른 일감"}).json()
    c = auth_client.post(f"{base}/{task['id']}/comments", json={"body": "x"}).json()
    assert auth_client.patch(f"{base}/{other_task['id']}/comments/{c['id']}", json={"body": "y"}).status_code == 404

    other_project = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    assert auth_client.get(f"/api/projects/{other_project['id']}/tasks/{task['id']}/comments").status_code == 404


def test_deleting_task_removes_comments_and_activity(app, auth_client, base, task):
    auth_client.post(f"{base}/{task['id']}/comments", json={"body": "x"})
    auth_client.patch(f"{base}/{task['id']}", json={"stage": "done"})
    # 기본 삭제는 휴지통 이동(복구 대비 덧글·이력 보존), permanent=true 는 영구 삭제
    assert auth_client.delete(f"{base}/{task['id']}", params={"permanent": True}).status_code == 204
    assert app.state.db.comments.list() == []
    assert app.state.db.task_activities.list() == []


def test_deleting_project_removes_comments_and_activity(app, auth_client, project, base, task):
    auth_client.post(f"{base}/{task['id']}/comments", json={"body": "x"})
    auth_client.delete(f"/api/projects/{project['id']}")
    assert app.state.db.comments.list() == []
    assert app.state.db.task_activities.list() == []
