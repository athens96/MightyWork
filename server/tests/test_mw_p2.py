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
