from datetime import timedelta

from app.models.common import utcnow
from tests.conftest import login


def test_task_and_wiki_soft_delete_restore_and_purge(app, auth_client, project):
    pid = project["id"]
    tbase = f"/api/projects/{pid}/tasks"
    wbase = f"/api/projects/{pid}/wiki/pages"
    trash_base = f"/api/projects/{pid}/trash"

    t = auth_client.post(tbase, json={"title": "복구할 일감", "version": "v1.0.0"}).json()
    auth_client.post(f"{tbase}/{t['id']}/comments", json={"body": "보존될 덧글"})
    w = auth_client.post(wbase, json={"title": "복구할 위키", "content": "중요 본문"}).json()
    auth_client.post(f"{wbase}/{w['id']}/comments", json={"body": "위키 댓글"})

    # 1) 기본 삭제 → 휴지통 이동 (일반 조회·검색·릴리즈에서 제외)
    assert auth_client.delete(f"{tbase}/{t['id']}").status_code == 204
    assert auth_client.delete(f"{wbase}/{w['id']}").status_code == 204

    assert auth_client.get(f"{tbase}/{t['id']}").status_code == 404
    assert auth_client.get(tbase).json() == []
    assert auth_client.get(f"{wbase}/{w['id']}").status_code == 404
    assert auth_client.get(wbase).json() == []
    assert auth_client.get(f"/api/projects/{pid}/search", params={"q": "복구할"}).json() == []
    assert auth_client.get(f"/api/projects/{pid}/releases").json()["releases"] == []

    # 2) 휴지통 목록에 두 항목 모두 노출
    trash = auth_client.get(trash_base).json()
    assert {(i["kind"], i["id"]) for i in trash} == {("task", t["id"]), ("wiki", w["id"])}
    assert all(i["days_left"] >= 29 for i in trash)

    # 3) 복구 → 원상 복귀 (덧글·검색 포함)
    assert auth_client.post(f"{trash_base}/task/{t['id']}/restore").status_code == 200
    assert auth_client.post(f"{trash_base}/wiki/{w['id']}/restore").status_code == 200
    assert auth_client.get(trash_base).json() == []
    assert auth_client.get(f"{tbase}/{t['id']}").status_code == 200
    assert len(auth_client.get(f"{tbase}/{t['id']}/comments").json()) == 1
    assert auth_client.get(f"{wbase}/{w['id']}").status_code == 200
    assert len(auth_client.get(f"{wbase}/{w['id']}/comments").json()) == 1
    assert len(auth_client.get(f"/api/projects/{pid}/search", params={"q": "복구할"}).json()) == 2

    # 4) 영구 삭제 → 완전 제거
    assert auth_client.delete(f"{tbase}/{t['id']}").status_code == 204
    assert auth_client.delete(f"{trash_base}/task/{t['id']}").status_code == 204
    assert app.state.db.tasks.get(t["id"]) is None
    assert app.state.db.comments.list(lambda c: c.task_id == t["id"]) == []


def test_trash_auto_purges_after_30_days_and_empty_requires_admin(app, auth_client, project):
    pid = project["id"]
    tbase = f"/api/projects/{pid}/tasks"
    trash_base = f"/api/projects/{pid}/trash"

    old = auth_client.post(tbase, json={"title": "오래된 휴지통"}).json()
    fresh = auth_client.post(tbase, json={"title": "최근 휴지통"}).json()
    auth_client.delete(f"{tbase}/{old['id']}")
    auth_client.delete(f"{tbase}/{fresh['id']}")

    # old 의 deleted_at 을 31일 전으로 조작
    stored = app.state.db.tasks.get(old["id"])
    assert stored is not None
    app.state.db.tasks.update(stored.model_copy(update={"deleted_at": utcnow() - timedelta(days=31)}))

    # 조회 시 30일 경과 항목 자동 정리
    trash = auth_client.get(trash_base).json()
    assert [i["id"] for i in trash] == [fresh["id"]]
    assert app.state.db.tasks.get(old["id"]) is None

    # 비관리자는 휴지통 비우기 403, 관리자는 성공
    bob = login(app, "u2:bob@example.com")
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com", "permissions": ["view", "delete"]})
    assert bob.post(f"{trash_base}/empty").status_code == 403
    assert auth_client.post(f"{trash_base}/empty").json() == {"purged": 1}
    assert auth_client.get(trash_base).json() == []
