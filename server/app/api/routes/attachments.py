"""프로젝트 범위 이미지·파일 첨부 API (권한 격리, SVG/HTML 인라인 실행 차단, 일감·위키별 목록 지원)."""

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, DbDep, ProjectDep, SettingsDep, require
from app.models.attachment import Attachment, AttachmentRead
from app.models.member import Permission
from app.services.audit import record_audit

router = APIRouter(prefix="/projects/{project_id}/attachments", tags=["attachments"])

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10MB
INLINE_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
ALLOWED_CONTENT_TYPES = INLINE_IMAGE_TYPES | {
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/hwp+zip",
    "application/x-hwp",
    "application/octet-stream",
}


def _file_path(data_dir: Path, project_id: str, attachment_id: str) -> Path:
    return data_dir / "attachments" / project_id / attachment_id


def _read(att: Attachment) -> AttachmentRead:
    return AttachmentRead(**att.model_dump(), url=f"/api/projects/{att.project_id}/attachments/{att.id}")


@router.get("", response_model=list[AttachmentRead])
def list_attachments(
    project: ProjectDep,
    db: DbDep,
    task_id: str | None = None,
    wiki_page_id: str | None = None,
) -> list[AttachmentRead]:
    items = db.attachments.list(
        lambda a: a.project_id == project.id
        and (task_id is None or a.task_id == task_id)
        and (wiki_page_id is None or a.wiki_page_id == wiki_page_id)
    )
    return [_read(a) for a in sorted(items, key=lambda a: a.created_at, reverse=True)]


@router.post("", response_model=AttachmentRead, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
async def upload_attachment(
    project: ProjectDep,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
    file: UploadFile = File(...),
    task_id: str | None = Form(None),
    wiki_page_id: str | None = Form(None),
) -> AttachmentRead:
    data = await file.read(MAX_ATTACHMENT_BYTES + 1)
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "파일이 너무 큽니다 (최대 10MB)")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "빈 파일은 업로드할 수 없습니다")
    if task_id:
        t = db.tasks.get(task_id)
        if t is None or t.project_id != project.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    if wiki_page_id:
        p = db.wiki_pages.get(wiki_page_id)
        if p is None or p.project_id != project.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    content_type = (file.content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, f"지원하지 않는 파일 형식입니다: {content_type}")
    filename = Path(file.filename or "file").name[:200] or "file"
    att = Attachment(
        project_id=project.id,
        filename=filename,
        content_type=content_type,
        size=len(data),
        uploaded_by=user.id,
        task_id=task_id or None,
        wiki_page_id=wiki_page_id or None,
    )
    dst = _file_path(settings.data_dir, project.id, att.id)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    db.attachments.create(att)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="attachment.uploaded",
        target_type="attachment",
        target_id=att.id,
        summary=f"첨부 업로드: {att.filename} ({att.size}B)",
    )
    return _read(att)


@router.get("/{attachment_id}")
def download_attachment(
    project: ProjectDep,
    attachment_id: str,
    db: DbDep,
    settings: SettingsDep,
) -> FileResponse:
    att = db.attachments.get(attachment_id)
    if att is None or att.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    path = _file_path(settings.data_dir, project.id, att.id)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment file missing")
    inline = att.content_type in INLINE_IMAGE_TYPES
    disposition = "inline" if inline else "attachment"
    ascii_name = att.filename.encode("ascii", "ignore").decode().strip() or "file"
    return FileResponse(
        path,
        media_type=att.content_type if inline else "application/octet-stream",
        headers={
            "Content-Disposition": f'{disposition}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(att.filename)}',
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.delete("/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_attachment(
    project: ProjectDep,
    attachment_id: str,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
) -> Response:
    att = db.attachments.get(attachment_id)
    if att is None or att.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    _file_path(settings.data_dir, project.id, att.id).unlink(missing_ok=True)
    db.attachments.delete(att.id)
    record_audit(
        db,
        project_id=project.id,
        actor_id=user.id,
        action="attachment.deleted",
        target_type="attachment",
        target_id=att.id,
        summary=f"첨부 삭제: {att.filename}",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
