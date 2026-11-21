"""P2 백로그(MW-11 ~ MW-13) 백엔드 테스트."""

from datetime import date, timedelta


def test_mw11_triage_queue_decisions_and_external_intake(auth_client, client, project):
    pid = project["id"]
    existing = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "기존 로그인 버그"}).json()

    # 1) 외부 인테이크 토큰 활성화 및 비인증 제보 접수
    cfg = auth_client.put(f"/api/projects/{pid}/intake", json={"enabled": True}).json()
    assert cfg["enabled"] and cfg["token"]

    pub1 = client.post(
        f"/api/intake/{cfg['token']}",
        json={"title": "외부 제보: 모바일 깨짐", "description": "iOS Safari", "reporter_name": "고객A", "priority": "high"},
    )
    assert pub1.status_code == 201, pub1.text
    t1_id = pub1.json()["task_id"]

    # 트리아지 대기 항목은 기본 보드 목록(/tasks)에 섞이지 않고 /triage 에만 노출
    assert [t["id"] for t in auth_client.get(f"/api/projects/{pid}/tasks").json()] == [existing["id"]]
    queue = auth_client.get(f"/api/projects/{pid}/triage").json()
    assert [t["id"] for t in queue] == [t1_id] and queue[0]["triage_status"] == "pending"

    # 2) 수락(accept → todo) 하면 보드로 이동
    accepted = auth_client.post(f"/api/projects/{pid}/triage/{t1_id}/decide", json={"action": "accept", "target_stage": "todo"})
    assert accepted.status_code == 200 and accepted.json()["triage_status"] is None and accepted.json()["stage"] == "todo"
    assert len(auth_client.get(f"/api/projects/{pid}/tasks").json()) == 2

    # 3) 중복 병합(duplicate) → TaskLink(duplicates) 생성 + 대기열에서 닫힘
    t2 = auth_client.post(f"/api/projects/{pid}/triage", json={"title": "로그인 안됨(중복)"}).json()
    dup = auth_client.post(
        f"/api/projects/{pid}/triage/{t2['id']}/decide",
        json={"action": "duplicate", "duplicate_of_id": existing["id"]},
    )
    assert dup.status_code == 200 and dup.json()["triage_status"] == "declined"
    links = auth_client.get(f"/api/projects/{pid}/tasks/{existing['id']}/links").json()
    assert any(l["kind"] == "duplicated_by" and l["task_id"] == t2["id"] for l in links)

    # 4) 보류(snooze) 및 거절(decline)
    t3 = auth_client.post(f"/api/projects/{pid}/triage", json={"title": "추후 검토 요청"}).json()
    snoozed = auth_client.post(
        f"/api/projects/{pid}/triage/{t3['id']}/decide",
        json={"action": "snooze", "snooze_until": (date.today() + timedelta(days=5)).isoformat()},
    )
    assert snoozed.status_code == 200 and snoozed.json()["triage_status"] == "snoozed"
    declined = auth_client.post(f"/api/projects/{pid}/triage/{t3['id']}/decide", json={"action": "decline"})
    assert declined.status_code == 200 and declined.json()["triage_status"] == "declined"
    assert auth_client.get(f"/api/projects/{pid}/triage").json() == []


def test_mw12_milestones_crud_progress_and_filtering(auth_client, project):
    pid = project["id"]
    today = date.today()
    m = auth_client.post(
        f"/api/projects/{pid}/milestones",
        json={
            "name": "v1.0 정식 출시",
            "description": "P0/P1 핵심 기능 완료",
            "start_date": today.isoformat(),
            "target_date": (today + timedelta(days=30)).isoformat(),
            "status": "active",
        },
    )
    assert m.status_code == 201, m.text
    mid = m.json()["id"]

    t1 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "일감 1", "stage": "done", "estimate": 3, "milestone_id": mid}).json()
    t2 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "일감 2", "stage": "done", "estimate": 5, "milestone_id": mid}).json()
    t3 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "일감 3", "stage": "in_progress", "estimate": 2, "milestone_id": mid}).json()
    auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "기타 일감"})

    listed = auth_client.get(f"/api/projects/{pid}/milestones").json()
    assert len(listed) == 1
    assert listed[0]["total_tasks"] == 3 and listed[0]["done_tasks"] == 2 and listed[0]["in_progress_tasks"] == 1
    assert listed[0]["progress_pct"] == 67 and listed[0]["done_points"] == 8 and listed[0]["total_points"] == 10

    filtered = auth_client.get(f"/api/projects/{pid}/tasks", params={"milestone_id": mid}).json()
    assert {t["id"] for t in filtered} == {t1["id"], t2["id"], t3["id"]}

    assert auth_client.delete(f"/api/projects/{pid}/milestones/{mid}").status_code == 204
    assert auth_client.get(f"/api/projects/{pid}/tasks/{t1['id']}").json()["milestone_id"] is None


def test_mw13_agent_automation_hook_filters(auth_client, project):
    from app.services.webhooks import set_webhook_sender

    pid = project["id"]
    hits: list[str] = []

    def fake_sender(url: str, raw: bytes, headers: dict[str, str]) -> int:
        hits.append(f"{headers.get('X-MightyWork-Event')}:{url}")
        return 200

    set_webhook_sender(fake_sender)
    try:
        # AI 에이전트 전용 자동화 훅: 레이블 'ai-agent' + 단계 'todo' 일 때만 트리거
        hook = auth_client.post(
            f"/api/projects/{pid}/webhooks",
            json={
                "name": "Claude Code 자동 실행기",
                "url": "https://agent.example.com/trigger",
                "preset": "custom",
                "events": ["task.created", "task.stage_changed", "task.updated"],
                "trigger_tags": ["ai-agent"],
                "trigger_stages": ["todo"],
            },
        )
        assert hook.status_code == 201, hook.text
        assert hook.json()["trigger_tags"] == ["ai-agent"] and hook.json()["trigger_stages"] == ["todo"]

        # 조건 미충족 일감 → 트리거되지 않음
        t_normal = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "일반 작업", "stage": "todo"}).json()
        assert hits == []

        # 레이블만 있고 단계가 backlog → 아직 트리거되지 않음
        auth_client.patch(f"/api/projects/{pid}/tasks/{t_normal['id']}", json={"stage": "backlog", "tags": ["ai-agent"]})
        assert hits == []

        # 단계가 todo 로 이동 + ai-agent 레이블 보유 → 자동화 훅 트리거!
        auth_client.patch(f"/api/projects/{pid}/tasks/{t_normal['id']}", json={"stage": "todo"})
        assert any("agent.example.com/trigger" in h for h in hits)
    finally:
        set_webhook_sender(None)
