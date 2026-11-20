import io
import zipfile
from urllib.parse import unquote

import pytest

from tests.conftest import login


@pytest.fixture
def pid(project) -> str:
    return project["id"]


def page(client, pid, title, content="", **kw):
    res = client.post(f"/api/projects/{pid}/wiki/pages", json={"title": title, "content": content, **kw})
    assert res.status_code == 201, res.text
    return res.json()


@pytest.fixture
def tree(auth_client, pid):
    root = page(auth_client, pid, "개발 가이드", "# 개요\n규칙은 [[코딩 규칙]], 외부는 [[다른 문서|다른 것]].\n\n```\n# 코드 안 제목 [[코드]]\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 완료\n\n<script>alert(1)</script>",
                aliases=["가이드"], tags=["dev"], page_type="guide", status="published")
    child = page(auth_client, pid, "코딩 규칙", "## 이름 규칙\n카멜케이스", parent_id=root["id"])
    page(auth_client, pid, "다른 문서", "무관")
    return root, child


def get(client, pid, page_id, **params):
    return client.get(f"/api/projects/{pid}/wiki/pages/{page_id}/export", params=params)


def test_markdown_keeps_wiki_syntax_with_front_matter(auth_client, pid, tree):
    root, _ = tree
    res = get(auth_client, pid, root["id"], format="md")
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/markdown")
    body = res.text
    assert body.startswith("---\ntitle: \"개발 가이드\"\naliases: [\"가이드\"]\ntags: [\"dev\"]\ntype: \"guide\"\nstatus: \"published\"\n")
    assert "[[코딩 규칙]]" in body  # 옵시디언 호환을 위해 원문 유지
    assert "filename*=UTF-8''" in res.headers["content-disposition"]
    assert unquote(res.headers["content-disposition"].split("''")[1]) == "개발 가이드.md"


def test_markdown_with_children_shifts_headings(auth_client, pid, tree):
    root, _ = tree
    body = get(auth_client, pid, root["id"], format="md", children=True).text
    assert "\n# 개발 가이드\n" in body and "\n## 개요\n" in body  # 본문 제목은 한 단계 아래
    assert "\n## 코딩 규칙\n" in body and "\n#### 이름 규칙\n" in body  # 하위 페이지는 두 단계 아래
    assert "# 코드 안 제목" in body and "## 코드 안 제목" not in body  # 코드 블록은 그대로


def test_html_resolves_links_escapes_html_and_renders_gfm(auth_client, pid, tree):
    root, child = tree
    single = get(auth_client, pid, root["id"], format="html").text
    assert "<table>" in single and 'type="checkbox"' in single and "<h2>개요</h2>" in single
    assert "<script>alert(1)</script>" not in single and "&lt;script&gt;" in single  # 원시 HTML 이스케이프
    assert "코딩 규칙" in single and 'href="#page-' not in single  # 묶음 밖 링크는 글자만
    assert "다른 것" in single and "[[" not in single.split("<pre>")[0]
    assert "[[코드]]" in single  # 코드 안은 유지
    assert "별칭</b>가이드" in single and "타입</b>가이드" in single and "상태</b>확정" in single

    bundled = get(auth_client, pid, root["id"], format="html", children=True).text
    assert f'href="#page-{child["id"]}"' in bundled and f'id="page-{child["id"]}"' in bundled  # 묶음 안 링크는 문서 내 이동
    assert "window.print" not in bundled and "print()" not in bundled
    printable = get(auth_client, pid, root["id"], format="html", print=True)
    assert "print()" in printable.text and printable.headers["content-disposition"].startswith("inline")


def test_project_zip_is_obsidian_vault(auth_client, pid, tree):
    res = auth_client.get(f"/api/projects/{pid}/wiki/export.zip")
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(res.content))
    names = set(z.namelist())
    assert {"wiki/개발 가이드.md", "wiki/개발 가이드/코딩 규칙.md", "wiki/다른 문서.md", "wiki.html"} <= names
    assert z.read("wiki/개발 가이드.md").decode().startswith("---\ntitle: \"개발 가이드\"")


def test_export_requires_membership(app, auth_client, pid, tree):
    root, _ = tree
    bob = login(app, "u2:bob@example.com")
    assert get(bob, pid, root["id"], format="html").status_code == 404
    assert bob.get(f"/api/projects/{pid}/wiki/export.zip").status_code == 404
    assert get(auth_client, pid, "nope", format="md").status_code == 404


# ---------------------------------------------------------------- Word

def test_docx_export(auth_client, pid, tree):
    root, _ = tree
    res = get(auth_client, pid, root["id"], format="docx", children=True)
    assert res.status_code == 200 and res.headers["content-type"].endswith("wordprocessingml.document")
    z = zipfile.ZipFile(io.BytesIO(res.content))
    doc = z.read("word/document.xml").decode()
    assert "개발 가이드" in doc and "코딩 규칙" in doc and "카멜케이스" in doc
    assert "<w:tbl>" in doc  # 표 유지
    assert "[[코딩 규칙]]" not in doc and "다른 것" in doc  # 위키 링크는 표시 텍스트로
    assert "[[코드]]" in doc  # 코드 블록 안은 원문 유지
    assert 'w:eastAsia="ko-KR"' in z.read("word/styles.xml").decode()  # 한글 기본 글꼴
    assert unquote(res.headers["content-disposition"].split("''")[1]) == "개발 가이드.docx"


def test_docx_sandbox_blocks_local_files(auth_client, pid, tmp_path):
    secret = tmp_path / "secret.png"
    secret.write_bytes(b"\x89PNG\r\n\x1a\nnot really")
    p = page(auth_client, pid, "이미지", f"![x]({secret})\n\n![y](file://{secret})")
    res = get(auth_client, pid, p["id"], format="docx")
    assert res.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(res.content)).namelist()
    assert not any(n.startswith("word/media/") for n in names)  # 서버 파일을 끌어오지 않음
