"""위키 내보내기 API (보기 권한)."""

from enum import Enum
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Response, status

from app.api.deps import DbDep, ProjectDep
from app.services.export.archive import build_zip
from app.services.export.docx import render_docx
from app.services.export.html import render_html
from app.services.export.markdown import render_markdown
from app.services.export.prepare import collect, safe_filename

router = APIRouter(prefix="/projects/{project_id}/wiki", tags=["export"])


class ExportFormat(str, Enum):
    md = "md"
    html = "html"
    docx = "docx"


MEDIA = {
    "md": "text/markdown; charset=utf-8",
    "html": "text/html; charset=utf-8",
    "zip": "application/zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def download(content: bytes | str, filename: str, ext: str, *, inline: bool = False) -> Response:
    """한글 파일명은 RFC 5987(filename*) 로, 구형 클라이언트용 ASCII 이름도 함께."""
    disposition = "inline" if inline else "attachment"
    ascii_name = filename.encode("ascii", "ignore").decode().strip() or f"wiki.{ext}"
    return Response(
        content=content,
        media_type=MEDIA[ext],
        headers={"Content-Disposition": f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/pages/{page_id}/export")
def export_page(
    project: ProjectDep,
    page_id: str,
    db: DbDep,
    format: ExportFormat = ExportFormat.html,
    children: bool = Query(False, description="하위 페이지까지 하나의 문서로"),
    print_dialog: bool = Query(False, alias="print", description="HTML: 열자마자 인쇄 대화상자 (PDF로 저장)"),
) -> Response:
    page = db.wiki_pages.get(page_id)
    if page is None or page.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    blocks = collect(db, project, page, include_children=children)
    ext = format.value
    if format is ExportFormat.md:
        return download(render_markdown(db, project, blocks), safe_filename(page.title, ext), ext)
    if format is ExportFormat.docx:
        return download(render_docx(db, project, blocks), safe_filename(page.title, ext), ext)
    return download(render_html(db, project, blocks, print_on_load=print_dialog), safe_filename(page.title, ext), ext, inline=print_dialog)


@router.get("/export.zip")
def export_project_zip(project: ProjectDep, db: DbDep) -> Response:
    """프로젝트 위키 전체: 폴더 트리 + front matter 가 붙은 .md (옵시디언 볼트로 열림) + wiki.html."""
    return download(build_zip(db, project), safe_filename(f"{project.key} 위키", "zip"), "zip")
