"""P1 백로그(MW-6 ~ MW-10) 백엔드 테스트."""

from datetime import date, timedelta


def test_mw6_cycles_crud_burndown_and_rollover(auth_client, project):
    pid = project["id"]
    today = date.today()
    c1 = auth_client.post(
        f"/api/projects/{pid}/cycles",
        json={
            "name": "Sprint 1",
            "goal": "핵심 MVP 완성",
            "start_date": (today - timedelta(days=3)).isoformat(),
            "end_date": (today + timedelta(days=4)).isoformat(),
            "target_points": 10,
            "status": "active",
        },
    )
    assert c1.status_code == 201, c1.text
    c1_id = c1.json()["id"]

    # 일감 2건 배정 (1건 완료, 1건 진행 중)
    t_done = auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "완료될 일감", "stage": "done", "estimate": 5, "cycle_id": c1_id},
    ).json()
    t_open = auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "이월될 일감", "stage": "in_progress", "estimate": 3, "cycle_id": c1_id},
    ).json()
    auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "사이클 없는 일감"})

    # 사이클 필터링 조회
    filtered = auth_client.get(f"/api/projects/{pid}/tasks", params={"cycle_id": c1_id}).json()
    assert {t["id"] for t in filtered} == {t_done["id"], t_open["id"]}

    # 집계 및 번다운 시리즈 확인
    listed = auth_client.get(f"/api/projects/{pid}/cycles").json()
    assert len(listed) == 1
    assert listed[0]["total_tasks"] == 2 and listed[0]["done_tasks"] == 1
    assert listed[0]["total_points"] == 8 and listed[0]["done_points"] == 5
    assert listed[0]["completion_pct"] == 62
    assert len(listed[0]["burndown"]) >= 2

    # 사이클 완료 → 다음 사이클 자동 생성 + 미완료 1건 자동 이월
    res = auth_client.post(f"/api/projects/{pid}/cycles/{c1_id}/complete", json={"rollover": True})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["completed"]["status"] == "completed"
    assert body["rolled_over_count"] == 1
    assert body["next_cycle"] is not None
    assert body["next_cycle"]["status"] == "active"

    # 완료된 일감은 c1 에 남고, 미완료 일감은 next_cycle 로 이동
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t_done['id']}").json()["cycle_id"] == c1_id
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t_open['id']}").json()["cycle_id"] == body["next_cycle"]["id"]


def test_mw7_templates_and_bulk_edit(app, auth_client, project):
    from tests.conftest import login

    pid = project["id"]
    # 1) 템플릿 CRUD
    tpl = auth_client.post(
        f"/api/projects/{pid}/task-templates",
        json={
            "name": "버그 제보",
            "title_prefix": "[Bug] ",
            "description": "### 재현 경로\n1. ",
            "priority": "high",
            "tags": ["bug", "triage"],
            "checklist": ["재현 확인", "회귀 테스트 작성"],
        },
    )
    assert tpl.status_code == 201, tpl.text
    tid = tpl.json()["id"]
    assert len(auth_client.get(f"/api/projects/{pid}/task-templates").json()) == 1

    # 2) 일괄 편집 (단계·우선순위·작업자·레이블 추가)
    t1 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "일감 1"}).json()
    t2 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "일감 2", "tags": ["old"]}).json()

    res = auth_client.post(
        f"/api/projects/{pid}/tasks/bulk",
        json={
            "task_ids": [t1["id"], t2["id"]],
            "stage": "todo",
            "priority": "urgent",
            "assignee_id": "u1",
            "add_tags": ["sprint-1"],
            "remove_tags": ["old"],
        },
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["affected"] == 2
    assert all(x["stage"] == "todo" and x["priority"] == "urgent" and x["assignee_id"] == "u1" for x in data["tasks"])
    t2_after = next(x for x in data["tasks"] if x["id"] == t2["id"])
    assert t2_after["tags"] == ["sprint-1"]

    # 보기 전용 멤버는 일괄 편집 불가
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view"]})
    bob = login(app, "u2:bob@example.com")
    assert bob.post(f"/api/projects/{pid}/tasks/bulk", json={"task_ids": [t1["id"]], "stage": "done"}).status_code == 403

    # 일괄 삭제 + 템플릿 삭제
    del_res = auth_client.post(f"/api/projects/{pid}/tasks/bulk", json={"task_ids": [t1["id"]], "delete": True})
    assert del_res.status_code == 200 and del_res.json()["affected"] == 1
    assert auth_client.delete(f"/api/projects/{pid}/task-templates/{tid}").status_code == 204


def test_mw9_custom_pipeline_wip_and_hidden_remap(app, auth_client, project):
    from tests.conftest import login

    pid = project["id"]
    default_stages = auth_client.get(f"/api/projects/{pid}/pipeline").json()
    assert len(default_stages) == 6

    qa_task = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "QA 중 일감", "stage": "qa"}).json()

    custom = [
        {"key": "todo", "label": "준비됨", "color": "tone-idle", "hidden": False, "wip_limit": None},
        {"key": "in_progress", "label": "개발 중", "color": "tone-run", "hidden": False, "wip_limit": 2},
        {"key": "review", "label": "리뷰", "color": "tone-agent", "hidden": False, "wip_limit": 3},
        {"key": "done", "label": "완료", "color": "tone-done", "hidden": False, "wip_limit": None},
        {"key": "backlog", "label": "백로그", "color": "tone-stop", "hidden": True, "wip_limit": None},
        {"key": "qa", "label": "QA", "color": "tone-task", "hidden": True, "wip_limit": None},
    ]
    saved = auth_client.put(
        f"/api/projects/{pid}/pipeline",
        json={"stages": custom, "remap_hidden_to": "review"},
    )
    assert saved.status_code == 200, saved.text
    stages = saved.json()
    assert [s["key"] for s in stages[:4]] == ["todo", "in_progress", "review", "done"]
    assert stages[1]["label"] == "개발 중" and stages[1]["wip_limit"] == 2

    # 숨김 처리된 QA 단계에 있던 일감은 remap_hidden_to(review) 로 자동 이동
    assert auth_client.get(f"/api/projects/{pid}/tasks/{qa_task['id']}").json()["stage"] == "review"

    # 일반 멤버(편집 권한만)는 파이프라인 변경 불가
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view", "edit"]})
    bob = login(app, "u2:bob@example.com")
    assert bob.put(f"/api/projects/{pid}/pipeline", json={"stages": custom}).status_code == 403


def test_mw10_external_webhooks_slack_discord_retry_and_logs(auth_client, project):
    import hashlib
    import hmac
    import json

    from app.services.webhooks import set_webhook_sender

    pid = project["id"]
    sent: list[tuple[str, bytes, dict[str, str]]] = []
    fail_once = {"slack": True}

    def fake_sender(url: str, raw: bytes, headers: dict[str, str]) -> int:
        sent.append((url, raw, headers))
        if "hooks.slack.com" in url and fail_once["slack"]:
            fail_once["slack"] = False
            return 500
        return 200

    set_webhook_sender(fake_sender)
    try:
        # 사설 IP / http 차단 확인
        assert auth_client.post(f"/api/projects/{pid}/webhooks", json={"name": "bad", "url": "http://example.com/hook"}).status_code == 400
        assert auth_client.post(f"/api/projects/{pid}/webhooks", json={"name": "ssrf", "url": "https://127.0.0.1/hook"}).status_code == 400

        slack = auth_client.post(
            f"/api/projects/{pid}/webhooks",
            json={"name": "팀 슬랙", "url": "https://hooks.slack.com/services/T00/B00/XXX", "preset": "slack", "events": ["task.created", "due_soon"]},
        )
        assert slack.status_code == 201, slack.text
        slack_id = slack.json()["id"]

        custom = auth_client.post(
            f"/api/projects/{pid}/webhooks",
            json={"name": "커스텀 훅", "url": "https://example.com/mw-hook", "preset": "custom", "events": ["task.stage_changed"]},
        )
        assert custom.status_code == 201, custom.text
        custom_secret = custom.json()["generated_secret"]
        custom_id = custom.json()["id"]
        assert custom_secret

        # 1) 일감 생성 → Slack 1차 500 실패 후 재시도 200 성공
        t = auth_client.post(
            f"/api/projects/{pid}/tasks",
            json={"title": "웹훅 검증", "due_date": (date.today() + timedelta(days=1)).isoformat()},
        ).json()
        logs = auth_client.get(f"/api/projects/{pid}/webhooks/{slack_id}/deliveries").json()
        assert len(logs) == 1 and logs[0]["ok"] is True and logs[0]["attempts"] == 2
        slack_body = json.loads(sent[-1][1])
        assert "MW-1" in slack_body["text"]

        # 2) 단계 이동 → Custom Webhook HMAC-SHA256 서명 확인
        auth_client.patch(f"/api/projects/{pid}/tasks/{t['id']}", json={"stage": "in_progress"})
        url, raw, headers = sent[-1]
        assert url == "https://example.com/mw-hook"
        expected_sig = "sha256=" + hmac.new(custom_secret.encode(), raw, hashlib.sha256).hexdigest()
        assert headers["X-MightyWork-Signature-256"] == expected_sig
        assert headers["X-MightyWork-Event"] == "task.stage_changed"

        # 3) 테스트 발송 + 마감 임박 알림 트리거
        test_res = auth_client.post(f"/api/projects/{pid}/webhooks/{custom_id}/test")
        assert test_res.status_code == 200 and test_res.json()["ok"] is True
        due_res = auth_client.post(f"/api/projects/{pid}/webhooks/check-due-soon")
        assert due_res.status_code == 200 and due_res.json()["tasks"] == 1 and due_res.json()["dispatched"] == 1
    finally:
        set_webhook_sender(None)
