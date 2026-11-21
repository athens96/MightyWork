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
