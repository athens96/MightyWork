from pydantic import BaseModel

from app.models.common import Entity


class Attachment(Entity):
    """프로젝트 범위 첨부 파일 메타데이터 (실제 바이트는 data_dir/attachments/<project_id>/<id>)."""

    project_id: str
    filename: str
    content_type: str
    size: int
    uploaded_by: str
    task_id: str | None = None
    wiki_page_id: str | None = None


class AttachmentRead(Attachment):
    url: str
