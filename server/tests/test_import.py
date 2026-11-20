import pytest

from app.core.config import Settings
from app.services.export.hangul import available
from tests.conftest import login

needs_kordoc = pytest.mark.skipif(not available(Settings(_env_file=None)), reason="kordoc 미설치")


@pytest.fixture
def url(project) -> str:
    return f"/api/projects/{project['id']}/wiki/import"


def upload(client, url, name, data: bytes, **form):
    return client.post(url, files={"file": (name, data)}, data=form)


def test_import_markdown_restores_front_matter(auth_client, project, url):
    exported_page = auth_client.post(f"/api/projects/{project['id']}/wiki/pages", json={"title": "원본", "content": "본문 [[링크]]", "aliases": ["별칭"], "tags": ["t1"], "page_type": "decision", "status": "review"}).json()
    md = auth_client.get(f"/api/projects/{project['id']}/wiki/pages/{exported_page['id']}/export", params={"format": "md"}).content

    res = upload(auth_client, url, "아무 이름.md", md)
    assert res.status_code == 201, res.text
    p = res.json()
    assert (p["title"], p["aliases"], p["tags"], p["page_type"], p["status"]) == ("원본", ["별칭"], ["t1"], "decision", "review")
    assert p["content"].strip() == "본문 [[링크]]"  # 첫 # 제목은 본문에서 빠짐


def test_import_plain_text_uses_filename_and_strips_local_images(auth_client, url):
    res = upload(auth_client, url, "회의 메모.txt", "첫 줄\n![로컬](./a.png) ![원격](https://x.y/b.png)".encode())
    p = res.json()
    assert p["title"] == "회의 메모"
    assert "./a.png" not in p["content"] and "https://x.y/b.png" in p["content"]


def test_import_under_parent_and_validation(auth_client, project, url):
    parent = auth_client.post(f"/api/projects/{project['id']}/wiki/pages", json={"title": "부모"}).json()
    assert upload(auth_client, url, "a.md", b"# A", parent_id=parent["id"]).json()["parent_id"] == parent["id"]
    assert upload(auth_client, url, "a.md", b"x", parent_id="nope").status_code == 400
    assert upload(auth_client, url, "virus.exe", b"MZ").status_code == 415
    assert upload(auth_client, url, "noext", b"x").status_code == 415


def test_import_size_limit(auth_client, url, monkeypatch):
    import app.api.routes.importer as mod

    monkeypatch.setattr(mod, "MAX_BYTES", 10)
    assert upload(auth_client, url, "big.md", b"x" * 11).status_code == 413


def test_import_requires_create(app, auth_client, project, url):
    auth_client.post(f"/api/projects/{project['id']}/members", json={"email": "bob@example.com", "permissions": ["view"]})
    bob = login(app, "u2:bob@example.com")
    assert upload(bob, url, "a.md", b"x").status_code == 403


@needs_kordoc
@pytest.mark.parametrize("fmt", ["hwpx", "hwp", "docx"])
def test_import_roundtrip_office_formats(auth_client, project, url, fmt):
    src = auth_client.post(f"/api/projects/{project['id']}/wiki/pages", json={"title": "왕복 테스트", "content": "## 개요\n결제 흐름 설명\n\n| a | b |\n|---|---|\n| 1 | 2 |"}).json()
    data = auth_client.get(f"/api/projects/{project['id']}/wiki/pages/{src['id']}/export", params={"format": fmt}).content
    res = upload(auth_client, url, f"왕복.{fmt}", data)
    assert res.status_code == 201, res.text
    content = res.json()["content"]
    assert "결제 흐름 설명" in content and "| 1 | 2 |" in content.replace("  ", " ")
