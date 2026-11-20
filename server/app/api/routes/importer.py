from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, DbDep, ProjectDep, SettingsDep, require
from app.api.routes.wiki import _validate_parent
from app.models.member import Permission
from app.models.wiki import WikiPage
from app.services.export.hangul import ConversionFailed, ConverterUnavailable
from app.services.importer import ALLOWED_EXT, MAX_BYTES, UnsupportedFile, to_page

router = APIRouter(prefix="/projects/{project_id}/wiki", tags=["import"])


@router.post("/import", response_model=WikiPage, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
async def import_page(
    project: ProjectDep,
    user: CurrentUser,
    db: DbDep,
    settings: SettingsDep,
    file: UploadFile = File(..., description=f"지원: {', '.join(sorted(ALLOWED_EXT))} (최대 {MAX_BYTES // 1024 // 1024}MB)"),
    parent_id: str | None = Form(None),
) -> WikiPage:
    """HWP·HWPX·DOCX·PDF·PPTX·XLSX·Markdown 문서를 새 위키 페이지로 가져온다 (생성 권한)."""
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"파일이 너무 큽니다 (최대 {MAX_BYTES // 1024 // 1024}MB)")
    _validate_parent(db, project, None, parent_id or None)
    try:
        # kordoc 하위 프로세스 실행이 이벤트 루프를 막지 않도록 스레드풀에서 변환
        imported = await run_in_threadpool(to_page, settings, file.filename or "", data)
    except UnsupportedFile as e:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(e))
    except ConverterUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"문서 변환기를 사용할 수 없습니다: {e}")
    except ConversionFailed as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"문서를 읽지 못했습니다: {e}")
    page = WikiPage(
        project_id=project.id,
        parent_id=parent_id or None,
        title=imported.title,
        content=imported.content,
        created_by=user.id,
        updated_by=user.id,
        **imported.props,
    )
    return db.wiki_pages.create(page)
