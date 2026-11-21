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


def test_mw4_github_webhook_pr_and_push_auto_stage(auth_client, client, project):
    import hashlib
    import hmac
    import json

    pid = project["id"]
    t = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "GitHub 연동"}).json()  # MW-1
    cfg = auth_client.put(f"/api/projects/{pid}/github", json={"repo": "athens96/MightyWork", "auto_transition": True}).json()
    secret = cfg["generated_secret"]
    assert secret and cfg["has_secret"]

    def post_hook(event: str, payload: dict, bad_sig: bool = False):
        raw = json.dumps(payload).encode()
        digest = hmac.new((secret + ("x" if bad_sig else "")).encode(), raw, hashlib.sha256).hexdigest()
        return client.post(
            "/api/webhooks/github",
            content=raw,
            headers={"Content-Type": "application/json", "X-GitHub-Event": event, "X-Hub-Signature-256": f"sha256={digest}"},
        )

    # 1) 잘못된 서명은 401
    push_payload = {
        "repository": {"full_name": "athens96/MightyWork"},
        "ref": "refs/heads/feat/mw-1-github",
        "commits": [{"id": "abcdef1234567", "message": "MW-1 초안 구현", "url": "https://github.com/athens96/MightyWork/commit/abcdef1", "author": {"username": "dev"}}],
    }
    assert post_hook("push", push_payload, bad_sig=True).status_code == 401

    # 2) Push → in_progress + commit 링크
    assert post_hook("push", push_payload).json()["matched"] == 1
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t['id']}").json()["stage"] == "in_progress"

    # 3) PR opened → review, PR merged → done
    pr_open = {
        "action": "opened",
        "repository": {"full_name": "athens96/MightyWork"},
        "pull_request": {
            "number": 42,
            "title": "[MW-1] GitHub 연동 추가",
            "body": "",
            "state": "open",
            "merged": False,
            "html_url": "https://github.com/athens96/MightyWork/pull/42",
            "head": {"ref": "feat/mw-1-github"},
            "user": {"login": "dev"},
        },
    }
    assert post_hook("pull_request", pr_open).json()["matched"] == 1
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t['id']}").json()["stage"] == "review"

    pr_merge = {**pr_open, "action": "closed", "pull_request": {**pr_open["pull_request"], "state": "closed", "merged": True}}
    assert post_hook("pull_request", pr_merge).json()["matched"] == 1
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t['id']}").json()["stage"] == "done"

    links = auth_client.get(f"/api/projects/{pid}/tasks/{t['id']}/github").json()
    assert len(links) == 2 and any(l["kind"] == "pr" and l["state"] == "merged" for l in links)


def test_mw5_sse_project_events_and_notifications(app, auth_client, project):
    pid = project["id"]
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view", "create", "edit"]})
    bob = login(app, "u2:bob@example.com")
    stranger = login(app, "u3:stranger@example.com")

    # 프로젝트 멤버가 아니면 SSE 구독 불가
    assert stranger.get(f"/api/projects/{pid}/events", params={"once": True}).status_code == 404

    # 기준 시점 이후 일감 생성·단계 변경·덧글·배정 알림 발생
    t = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "SSE 실시간", "assignee_id": "u2"}).json()
    auth_client.patch(f"/api/projects/{pid}/tasks/{t['id']}", json={"stage": "in_progress"})
    auth_client.post(f"/api/projects/{pid}/tasks/{t['id']}/comments", json={"body": "실시간 확인"})

    res = bob.get(f"/api/projects/{pid}/events", params={"since": 0, "once": True})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert res.headers.get("x-accel-buffering") == "no"
    body = res.text
    assert "event: connected" in body
    assert "event: task.created" in body
    assert "event: task.updated" in body
    assert "event: comment.created" in body
    assert "event: notification.created" in body

    # 개인 알림 스트림도 알림 이벤트를 수신해야 함
    user_stream = bob.get("/api/events", params={"since": 0, "once": True})
    assert user_stream.status_code == 200
    assert "event: notification.created" in user_stream.text
    assert "event: task.created" not in user_stream.text
