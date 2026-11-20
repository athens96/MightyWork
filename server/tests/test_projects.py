def test_project_crud(auth_client):
    res = auth_client.post("/api/projects", json={"key": "web", "name": "웹 리뉴얼"})
    assert res.status_code == 201
    project = res.json()
    assert project["key"] == "WEB"  # 대문자로 정규화

    assert [p["id"] for p in auth_client.get("/api/projects").json()] == [project["id"]]

    renamed = auth_client.patch(f"/api/projects/{project['id']}", json={"name": "웹 v2"}).json()
    assert renamed["name"] == "웹 v2" and renamed["key"] == "WEB"

    assert auth_client.delete(f"/api/projects/{project['id']}").status_code == 204
    assert auth_client.get(f"/api/projects/{project['id']}").status_code == 404


def test_project_key_validation_and_uniqueness(auth_client, project):
    assert auth_client.post("/api/projects", json={"key": "mw", "name": "dup"}).status_code == 409
    for bad in ["M", "1AB", "A-B", "TOOLONGKEY11"]:
        assert auth_client.post("/api/projects", json={"key": bad, "name": "x"}).status_code == 422, bad


def test_unknown_project_is_404(auth_client):
    assert auth_client.get("/api/projects/nope/tasks").status_code == 404
    assert auth_client.get("/api/projects/nope/wiki/pages").status_code == 404


def test_delete_project_cascades(auth_client, project, app):
    pid = project["id"]
    auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "t"})
    auth_client.post(f"/api/projects/{pid}/wiki/pages", json={"title": "p"})

    other = auth_client.post("/api/projects", json={"key": "OT", "name": "other"}).json()
    auth_client.post(f"/api/projects/{other['id']}/tasks", json={"title": "keep"})

    assert auth_client.delete(f"/api/projects/{pid}").status_code == 204
    db = app.state.db
    assert [t.title for t in db.tasks.list()] == ["keep"]
    assert db.wiki_pages.list() == []
