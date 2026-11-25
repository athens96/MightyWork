use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::models::{new_id, utcnow, Permission, WikiPage};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::export::{
    build_zip, collect, import_to_page, render_docx, render_hangul, render_html, render_markdown,
    safe_filename, ConvertError, ImportError, IMPORT_MAX_BYTES,
};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/wiki/pages/{page_id}/export", get(export_page))
        .route("/projects/{project_id}/wiki/export.zip", get(export_project_zip))
        .route("/projects/{project_id}/wiki/import", post(import_page))
}

fn media_type(ext: &str) -> &'static str {
    match ext {
        "md" => "text/markdown; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "zip" => "application/zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "hwpx" => "application/hwp+zip",
        "hwp" => "application/x-hwp",
        _ => "application/octet-stream",
    }
}

fn download_response(bytes: Vec<u8>, filename: &str, ext: &str, inline: bool) -> Response {
    let disposition = if inline { "inline" } else { "attachment" };
    let ascii: String = filename
        .chars()
        .filter(|c| c.is_ascii() && *c != '"' && *c != '\\' && !c.is_control())
        .collect();
    let fallback = if ascii.trim().is_empty() {
        format!("wiki.{ext}")
    } else {
        ascii.trim().to_string()
    };
    let encoded = urlencoding::encode(filename);
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(media_type(ext)));
    if let Ok(cd) = HeaderValue::from_str(&format!(
        r#"{disposition}; filename="{fallback}"; filename*=UTF-8''{encoded}"#
    )) {
        h.insert(header::CONTENT_DISPOSITION, cd);
    }
    res
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: Option<String>,
    #[serde(default)]
    children: bool,
    #[serde(default, rename = "print")]
    print_dialog: bool,
    preset: Option<String>,
}

async fn export_page(
    State(state): State<AppState>,
    Path((project_id, page_id)): Path<(String, String)>,
    Query(q): Query<ExportQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Response> {
    let access = require_project_access(&state, &project_id, &user)?;
    let page = state
        .db
        .wiki_pages
        .get(&page_id)?
        .ok_or_else(|| ApiError::not_found("Page not found"))?;
    if page.project_id != access.project.id || page.deleted_at.is_some() {
        return Err(ApiError::not_found("Page not found"));
    }

    let fmt = q.format.as_deref().unwrap_or("html").to_lowercase();
    if !matches!(fmt.as_str(), "md" | "html" | "docx" | "hwpx" | "hwp") {
        return Err(ApiError::unprocessable("format must be md, html, docx, hwpx, or hwp"));
    }
    if let Some(ref pre) = q.preset {
        if !matches!(
            pre.as_str(),
            "report" | "minutes" | "plan" | "notice" | "official" | "gaejosik" | "press"
        ) {
            return Err(ApiError::unprocessable("invalid preset"));
        }
    }

    let blocks = collect(&state.db, &access.project, &page, q.children);
    let filename = safe_filename(&page.title, &fmt);

    match fmt.as_str() {
        "md" => {
            let text = render_markdown(&state.db, &blocks);
            Ok(download_response(text.into_bytes(), &filename, "md", false))
        }
        "docx" => {
            let settings = state.settings.clone();
            let db = state.db.clone();
            let project = access.project.clone();
            let data = tokio::task::spawn_blocking(move || render_docx(&settings, &db, &project, &blocks))
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?
                .map_err(|e| match e {
                    ConvertError::Unavailable(m) => {
                        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("DOCX 변환기를 사용할 수 없습니다: {m}"))
                    }
                    ConvertError::Failed(m) => {
                        ApiError::new(StatusCode::BAD_GATEWAY, format!("DOCX 변환에 실패했습니다: {m}"))
                    }
                })?;
            Ok(download_response(data, &filename, "docx", false))
        }
        "hwpx" | "hwp" => {
            let settings = state.settings.clone();
            let db = state.db.clone();
            let project = access.project.clone();
            let fmt_owned = fmt.clone();
            let preset = q.preset.clone();
            let data = tokio::task::spawn_blocking(move || {
                render_hangul(&settings, &db, &project, &blocks, &fmt_owned, preset.as_deref())
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e| match e {
                ConvertError::Unavailable(m) => {
                    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("한글 변환기를 사용할 수 없습니다: {m}"))
                }
                ConvertError::Failed(m) => {
                    ApiError::new(StatusCode::BAD_GATEWAY, format!("한글 변환에 실패했습니다: {m}"))
                }
            })?;
            Ok(download_response(data, &filename, &fmt, false))
        }
        _ => {
            let html_str = render_html(&state.db, &access.project, &blocks, q.print_dialog);
            Ok(download_response(
                html_str.into_bytes(),
                &filename,
                "html",
                q.print_dialog,
            ))
        }
    }
}

async fn export_project_zip(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
) -> ApiResult<Response> {
    let access = require_project_access(&state, &project_id, &user)?;
    let bytes = build_zip(&state.db, &access.project).map_err(ApiError::internal)?;
    let filename = safe_filename(&format!("{} 위키", access.project.key), "zip");
    Ok(download_response(bytes, &filename, "zip", false))
}

async fn import_page(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<WikiPage>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut filename = String::new();
    let mut parent_id: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("Invalid multipart: {e}")))?
    {
        match field.name() {
            Some("file") => {
                filename = field.file_name().unwrap_or("").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("Failed reading upload: {e}")))?;
                if data.len() > IMPORT_MAX_BYTES {
                    return Err(ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        format!("파일이 너무 큽니다 (최대 {}MB)", IMPORT_MAX_BYTES / 1024 / 1024),
                    ));
                }
                file_bytes = Some(data.to_vec());
            }
            Some("parent_id") => {
                let s = field.text().await.unwrap_or_default();
                if !s.trim().is_empty() {
                    parent_id = Some(s.trim().to_string());
                }
            }
            _ => {}
        }
    }

    let data = file_bytes.ok_or_else(|| ApiError::unprocessable("file field is required"))?;
    if let Some(ref pid) = parent_id {
        let p = state.db.wiki_pages.get(pid)?;
        if p.as_ref().is_none_or(|x| x.project_id != access.project.id || x.deleted_at.is_some()) {
            return Err(ApiError::bad_request("Parent page not found"));
        }
    }

    let settings = state.settings.clone();
    let imported = tokio::task::spawn_blocking(move || import_to_page(&settings, &filename, &data))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| match e {
            ImportError::Unsupported(m) => ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, m),
            ImportError::Unavailable(m) => {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, format!("문서 변환기를 사용할 수 없습니다: {m}"))
            }
            ImportError::Failed(m) => {
                ApiError::unprocessable(format!("문서를 읽지 못했습니다: {m}"))
            }
        })?;

    let now = utcnow();
    let page = WikiPage {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id,
        parent_id,
        title: imported.title,
        content: imported.content,
        aliases: imported.aliases,
        tags: imported.tags,
        page_type: imported.page_type,
        status: imported.status,
        owner_id: None,
        created_by: user.id.clone(),
        updated_by: user.id,
        deleted_at: None,
        deleted_by: None,
    };
    state.db.wiki_pages.create(&page)?;
    crate::services::events::publish_event(
        &state.db,
        &state.events,
        &page.project_id,
        "wiki.created",
        serde_json::json!({ "page_id": page.id }),
    );
    Ok((StatusCode::CREATED, Json(page)))
}
