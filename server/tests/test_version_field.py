from datetime import datetime, timezone

from app.models.task import Task
from app.services.migrations import extract_version_from_tag, migrate_version_tags


def test_extract_version_from_tag():
    assert extract_version_from_tag("v0.5.9") == "v0.5.9"
    assert extract_version_from_tag("v0.5.10") == "v0.5.10"
    assert extract_version_from_tag("v0.6.0") == "v0.6.0"
    assert extract_version_from_tag("v0.6.x") == "v0.6.x"
    assert extract_version_from_tag("V0.6.X") == "v0.6.x"
    assert extract_version_from_tag("v0.7.0") == "v0.7.0"
    assert extract_version_from_tag("v1.0") == "v1.0"
    assert extract_version_from_tag("v2.x") == "v2.x"
    assert extract_version_from_tag("0.1.0") == "0.1.0"
    assert extract_version_from_tag("1.2.3-rc.1") == "1.2.3-rc.1"
    assert extract_version_from_tag("version:v0.2.0") == "v0.2.0"
    assert extract_version_from_tag("ver: 0.3.0") == "0.3.0"

    # 일반 레이블은 절대 매칭되면 안 됨
    for non_ver in ("p0", "p1", "p2", "versioning", "cycle:2026-11", "e2e", "ci-cd", "v2", "ux", "release"):
        assert extract_version_from_tag(non_ver) is None


def test_task_version_crud_filter_bulk_and_search(auth_client, project):
    pid = project["id"]
    r1 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "버전 일감 1", "version": " v0.5.10 ", "tags": ["ux"]})
    assert r1.status_code == 201
    t1 = r1.json()
    assert t1["version"] == "v0.5.10"

    r2 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "버전 없는 일감", "tags": ["backend"]})
    assert r2.status_code == 201
    t2 = r2.json()
    assert t2["version"] is None

    # 쿼리 필터
    listed = auth_client.get(f"/api/projects/{pid}/tasks", params={"version": "v0.5.10"}).json()
    assert [t["id"] for t in listed] == [t1["id"]]

    # PATCH 변경 + 변경 이력 기록 + 빈 문자열로 해제
    patched = auth_client.patch(f"/api/projects/{pid}/tasks/{t1['id']}", json={"version": "v0.6.0"}).json()
    assert patched["version"] == "v0.6.0"
    acts = auth_client.get(f"/api/projects/{pid}/tasks/{t1['id']}/activity").json()
    assert any(a["field"] == "version" and a["old"] == "v0.5.10" and a["new"] == "v0.6.0" for a in acts)

    cleared = auth_client.patch(f"/api/projects/{pid}/tasks/{t1['id']}", json={"version": "  "}).json()
    assert cleared["version"] is None

    # 일괄 편집 (version 지정 및 해제)
    bulk = auth_client.post(
        f"/api/projects/{pid}/tasks/bulk",
        json={"task_ids": [t1["id"], t2["id"]], "version": "v0.7.0"},
    )
    assert bulk.status_code == 200
    assert bulk.json()["affected"] == 2
    assert all(t["version"] == "v0.7.0" for t in bulk.json()["tasks"])

    # 전문 검색에서도 version 문자열로 검색됨
    hits = auth_client.get(f"/api/projects/{pid}/search", params={"q": "v0.7.0"}).json()
    assert {h["id"] for h in hits} == {t1["id"], t2["id"]}


def test_migrate_version_tags_idempotent_and_preserves_updated_at(app, auth_client, project):
    db = app.state.db
    user_id = auth_client.get("/api/auth/me").json()["id"]
    pid = project["id"]
    old_ts = datetime(2026, 10, 15, 9, 0, 0, tzinfo=timezone.utc)
    t_ver = db.tasks.create(
        Task(
            project_id=pid,
            number=1,
            title="MC 스타일 일감",
            tags=["cycle:2026-11", "v0.5.10", "mcp", "context"],
            created_by=user_id,
            created_at=old_ts,
            updated_at=old_ts,
        )
    )
    t_wild = db.tasks.create(
        Task(
            project_id=pid,
            number=2,
            title="와일드카드 버전 일감",
            tags=["cycle:2026-12", "v0.6.x", "cli"],
            created_by=user_id,
            created_at=old_ts,
            updated_at=old_ts,
        )
    )
    t_plain = db.tasks.create(
        Task(
            project_id=pid,
            number=3,
            title="일반 태그 일감",
            tags=["p0", "versioning", "ux"],
            created_by=user_id,
            created_at=old_ts,
            updated_at=old_ts,
        )
    )

    assert migrate_version_tags(db) == 2

    m1 = db.tasks.get(t_ver.id)
    assert m1 is not None
    assert m1.version == "v0.5.10"
    assert m1.tags == ["cycle:2026-11", "mcp", "context"]
    assert m1.updated_at == old_ts  # updated_at 보존 확인

    m2 = db.tasks.get(t_wild.id)
    assert m2 is not None
    assert m2.version == "v0.6.x"
    assert m2.tags == ["cycle:2026-12", "cli"]
    assert m2.updated_at == old_ts

    m3 = db.tasks.get(t_plain.id)
    assert m3 is not None
    assert m3.version is None
    assert m3.tags == ["p0", "versioning", "ux"]

    # 2회차 실행은 멱등(0건)
    assert migrate_version_tags(db) == 0
