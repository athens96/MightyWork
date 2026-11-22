def test_releases_dashboard_and_changelog_api(auth_client, project):
    pid = project["id"]
    pkey = project["key"]

    auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "핵심 MCP 허브", "version": "v0.5.10", "stage": "done", "tags": ["mcp"], "estimate": 5},
    )
    auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "모바일 스크롤 오류 수정", "version": "v0.5.10", "stage": "done", "tags": ["bug", "mobile"], "estimate": 2},
    )
    auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "메모리 정책 정비", "version": "v0.5.10", "stage": "in_progress", "tags": ["performance"], "estimate": 3},
    )
    auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "macOS 메뉴 정비", "version": "v0.5.9", "stage": "done", "tags": ["ux"], "estimate": 3},
    )
    auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "워크트리 프리뷰", "version": "v0.6.x", "stage": "backlog", "tags": ["ui"]},
    )
    auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "버전 미지정 일감", "stage": "todo"},
    )

    res = auth_client.get(f"/api/projects/{pid}/releases")
    assert res.status_code == 200
    body = res.json()
    assert body["unversioned_count"] == 1
    assert [r["version"] for r in body["releases"]] == ["v0.6.x", "v0.5.10", "v0.5.9"]

    r_510 = body["releases"][1]
    assert r_510["status"] == "in_progress"
    assert r_510["total_tasks"] == 3
    assert r_510["done_tasks"] == 2
    assert r_510["in_progress_tasks"] == 1
    assert r_510["total_points"] == 10
    assert r_510["done_points"] == 7
    assert r_510["progress_pct"] == 67

    r_59 = body["releases"][2]
    assert r_59["status"] == "released"
    assert r_59["progress_pct"] == 100

    r_6x = body["releases"][0]
    assert r_6x["status"] == "planned"

    # 완료 일감만 체인지로그
    cl = auth_client.get(f"/api/projects/{pid}/releases/v0.5.10/changelog")
    assert cl.status_code == 200
    cl_body = cl.json()
    assert cl_body["version"] == "v0.5.10"
    assert cl_body["included_tasks"] == 2
    assert f"**{pkey}-1** 핵심 MCP 허브" in cl_body["markdown"]
    assert f"**{pkey}-2** 모바일 스크롤 오류 수정" in cl_body["markdown"]
    assert "메모리 정책 정비" not in cl_body["markdown"]
    assert "🐛 버그 수정" in cl_body["markdown"]

    # 미완료 포함 체인지로그
    cl_all = auth_client.get(f"/api/projects/{pid}/releases/v0.5.10/changelog", params={"include_unfinished": True})
    assert cl_all.status_code == 200
    assert cl_all.json()["included_tasks"] == 3
    assert "🚧 진행 중 · 예정" in cl_all.json()["markdown"]
    assert f"**{pkey}-3** 메모리 정책 정비 (진행 중)" in cl_all.json()["markdown"]

    # 없는 버전은 404
    assert auth_client.get(f"/api/projects/{pid}/releases/v9.9.9/changelog").status_code == 404
