def test_wiki_tree_crud(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    root = auth_client.post(base, json={"title": "개발 가이드", "content": "# Hello"}).json()
    child = auth_client.post(base, json={"title": "코딩 컨벤션", "parent_id": root["id"]}).json()
    assert root["project_id"] == project["id"]

    summaries = auth_client.get(base).json()
    assert {s["id"] for s in summaries} == {root["id"], child["id"]}
    assert "content" not in summaries[0]

    updated = auth_client.patch(f"{base}/{root['id']}", json={"content": "# Updated"}).json()
    assert updated["content"] == "# Updated"

    # 자식이 있으면 삭제 불가
    assert auth_client.delete(f"{base}/{root['id']}").status_code == 409
    # 자식을 루트로 이동 후 삭제 가능
    assert auth_client.patch(f"{base}/{child['id']}", json={"parent_id": None}).json()["parent_id"] is None
    assert auth_client.delete(f"{base}/{root['id']}").status_code == 204


def test_wiki_rejects_cycles_and_missing_parent(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    a = auth_client.post(base, json={"title": "A"}).json()
    b = auth_client.post(base, json={"title": "B", "parent_id": a["id"]}).json()

    assert auth_client.patch(f"{base}/{a['id']}", json={"parent_id": b["id"]}).status_code == 400
    assert auth_client.patch(f"{base}/{a['id']}", json={"parent_id": a["id"]}).status_code == 400
    assert auth_client.post(base, json={"title": "C", "parent_id": "nope"}).status_code == 400


def test_wiki_isolated_between_projects(auth_client, project):
    page = auth_client.post(f"/api/projects/{project['id']}/wiki/pages", json={"title": "A"}).json()
    other = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    other_base = f"/api/projects/{other['id']}/wiki/pages"

    assert auth_client.get(other_base).json() == []
    assert auth_client.get(f"{other_base}/{page['id']}").status_code == 404
    # 다른 프로젝트의 페이지를 부모로 지정할 수 없음
    assert auth_client.post(other_base, json={"title": "B", "parent_id": page["id"]}).status_code == 400


# ---------------------------------------------------------------- Properties

from tests.conftest import login


def test_page_properties_and_filters(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    g = auth_client.post(base, json={"title": "온보딩 가이드", "page_type": "guide", "status": "published", "owner_id": "u1", "tags": [" onboarding ", "Onboarding", "팀"]}).json()
    assert (g["page_type"], g["status"], g["owner_id"], g["tags"]) == ("guide", "published", "u1", ["onboarding", "팀"])
    d = auth_client.post(base, json={"title": "DB 선택", "page_type": "decision", "status": "review", "tags": ["db"]}).json()
    auth_client.post(base, json={"title": "미분류 메모"})

    titles = lambda **params: [p["title"] for p in auth_client.get(base, params=params).json()]
    assert titles(page_type="decision") == ["DB 선택"]
    assert titles(status="published") == ["온보딩 가이드"]
    assert titles(tag="ONBOARDING") == ["온보딩 가이드"]  # 대소문자 무시
    assert titles(owner_id="u1") == ["온보딩 가이드"]
    assert len(titles()) == 3
    assert auth_client.get(base).json()[0]["tags"] == ["onboarding", "팀"]  # 목록에 Properties 포함

    upd = auth_client.patch(f"{base}/{d['id']}", json={"status": "published", "page_type": None}).json()
    assert (upd["status"], upd["page_type"]) == ("published", None)
    assert auth_client.patch(f"{base}/{d['id']}", json={"status": "unknown"}).status_code == 422


def test_owner_must_be_member_and_cleared_on_removal(app, auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    login(app, "u2:bob@example.com")
    assert auth_client.post(base, json={"title": "x", "owner_id": "u2"}).status_code == 400
    m = auth_client.post(f"/api/projects/{project['id']}/members", json={"email": "bob@example.com"}).json()
    p = auth_client.post(base, json={"title": "x", "owner_id": "u2"}).json()
    assert p["owner_id"] == "u2"
    auth_client.delete(f"/api/projects/{project['id']}/members/{m['id']}")
    assert auth_client.get(f"{base}/{p['id']}").json()["owner_id"] is None


def test_search_matches_page_tags(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    p = auth_client.post(base, json={"title": "배포 절차", "tags": ["devops"]}).json()
    hits = auth_client.get(f"/api/projects/{project['id']}/search", params={"q": "devops"}).json()
    assert hits[0]["id"] == p["id"]


# ---------------------------------------------------------------- MW-23: 위키 댓글 · 낙관적 잠금


def test_wiki_optimistic_lock_detects_concurrent_edit(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    p = auth_client.post(base, json={"title": "설계서", "content": "v1"}).json()
    v1_ts = p["updated_at"]

    # 올바른 expected_updated_at 로 수정 성공
    p2 = auth_client.patch(f"{base}/{p['id']}", json={"content": "v2", "expected_updated_at": v1_ts}).json()
    assert p2["content"] == "v2"
    assert "expected_updated_at" not in p2

    # 오래된 expected_updated_at(v1_ts) 로 수정 시도 → 409 Conflict
    r = auth_client.patch(f"{base}/{p['id']}", json={"content": "stale edit", "expected_updated_at": v1_ts})
    assert r.status_code == 409

    # expected_updated_at 없이 강제 덮어쓰기 성공
    p3 = auth_client.patch(f"{base}/{p['id']}", json={"content": "forced"}).json()
    assert p3["content"] == "forced"


def test_wiki_comments_crud_resolve_and_cascade_delete(app, auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    p = auth_client.post(base, json={"title": "API 규격", "content": "초안"}).json()
    cbase = f"{base}/{p['id']}/comments"

    assert auth_client.get(cbase).json() == []

    # 댓글 작성 + 수정 + 해결 토글
    c = auth_client.post(cbase, json={"body": "응답 코드 409도 문서화할까요?"}).json()
    assert c["resolved"] is False
    assert c["resolved_by"] is None

    c_upd = auth_client.patch(f"{cbase}/{c['id']}", json={"body": "409와 422 모두 문서화할까요?"}).json()
    assert "422" in c_upd["body"]

    c_res = auth_client.patch(f"{cbase}/{c['id']}", json={"resolved": True}).json()
    assert c_res["resolved"] is True
    assert c_res["resolved_by"] == "u1"

    c_reopen = auth_client.patch(f"{cbase}/{c['id']}", json={"resolved": False}).json()
    assert c_reopen["resolved"] is False
    assert c_reopen["resolved_by"] is None

    # 다른 멤버 권한 체크: 편집 권한 있는 멤버는 해결 가능, 본문 수정/삭제는 불가
    bob = login(app, "u2:bob@example.com")
    auth_client.post(f"/api/projects/{project['id']}/members", json={"email": "bob@example.com", "permissions": ["view", "create", "edit"]})
    assert bob.patch(f"{cbase}/{c['id']}", json={"body": "훔쳐쓰기"}).status_code == 403
    assert bob.patch(f"{cbase}/{c['id']}", json={"resolved": True}).json()["resolved_by"] == "u2"
    assert bob.delete(f"{cbase}/{c['id']}").status_code == 403

    # 작성자/관리자는 삭제 가능
    c2 = bob.post(cbase, json={"body": "확인했습니다 @u1"}).json()
    assert len(auth_client.get(cbase).json()) == 2
    assert auth_client.delete(f"{cbase}/{c['id']}").status_code == 204
    assert len(auth_client.get(cbase).json()) == 1

    # 페이지 삭제 시 남은 위키 댓글도 함께 정리
    assert auth_client.delete(f"{base}/{p['id']}").status_code == 204
    assert app.state.db.wiki_comments.get(c2["id"]) is None


def test_wiki_list_includes_backlink_and_broken_link_counts(auth_client, project):
    base = f"/api/projects/{project['id']}/wiki/pages"
    target = auth_client.post(base, json={"title": "핵심 아키텍처"}).json()
    src = auth_client.post(base, json={"title": "온보딩", "content": "[[핵심 아키텍처]] 와 [[아직 없는 문서]] 참고"}).json()
    orphan = auth_client.post(base, json={"title": "고립 문서", "content": "링크 없음"}).json()

    by_id = {p["id"]: p for p in auth_client.get(base).json()}
    assert (by_id[target["id"]]["backlink_count"], by_id[target["id"]]["broken_link_count"]) == (1, 0)
    assert (by_id[src["id"]]["backlink_count"], by_id[src["id"]]["broken_link_count"]) == (0, 1)
    assert (by_id[orphan["id"]]["backlink_count"], by_id[orphan["id"]]["broken_link_count"]) == (0, 0)
