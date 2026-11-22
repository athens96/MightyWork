use std::collections::HashMap;
use std::path::{Path as StdPath, PathBuf};

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::models::{new_id, utcnow, Attachment, AttachmentRead, Permission};
use crate::routes::deps::{require_perm, require_project_access, AuthUser};
use crate::services::audit::record_audit;
use crate::AppState;

const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const INLINE_IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
const ALLOWED_CONTENT_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
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
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/attachments",
            get(list_attachments).post(upload_attachment),
        )
        .route(
            "/projects/{project_id}/attachments/{attachment_id}",
            get(download_attachment).delete(delete_attachment),
        )
}

fn file_path(data_dir: &StdPath, project_id: &str, attachment_id: &str) -> PathBuf {
    data_dir.join("attachments").join(project_id).join(attachment_id)
}

fn to_read(att: Attachment) -> AttachmentRead {
    let url = format!("/api/projects/{}/attachments/{}", att.project_id, att.id);
    AttachmentRead { attachment: att, url }
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    task_id: Option<String>,
    wiki_page_id: Option<String>,
}

async fn list_attachments(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(q): Query<ListQuery>,
    AuthUser(user): AuthUser,
) -> ApiResult<Json<Vec<AttachmentRead>>> {
    let access = require_project_access(&state, &project_id, &user)?;
    let mut items: Vec<Attachment> = state
        .db
        .attachments
        .list_by_project(&access.project.id)?
        .into_iter()
        .filter(|a| {
            q.task_id.as_deref().is_none_or(|tid| a.task_id.as_deref() == Some(tid))
                && q.wiki_page_id
                    .as_deref()
                    .is_none_or(|wid| a.wiki_page_id.as_deref() == Some(wid))
        })
        .collect();
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(items.into_iter().map(to_read).collect()))
}

async fn upload_attachment(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    AuthUser(user): AuthUser,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<AttachmentRead>)> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Create)?;

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut filename: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut task_id: Option<String> = None;
    let mut wiki_page_id: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("Invalid multipart: {e}")))?
    {
        match field.name() {
            Some("file") => {
                filename = field.file_name().map(str::to_string);
                content_type = field.content_type().map(str::to_string);
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("Failed reading upload: {e}")))?;
                if data.len() > MAX_ATTACHMENT_BYTES {
                    return Err(ApiError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "파일이 너무 큽니다 (최대 10MB)",
                    ));
                }
                file_bytes = Some(data.to_vec());
            }
            Some("task_id") => {
                let s = field.text().await.unwrap_or_default();
                if !s.trim().is_empty() {
                    task_id = Some(s.trim().to_string());
                }
            }
            Some("wiki_page_id") => {
                let s = field.text().await.unwrap_or_default();
                if !s.trim().is_empty() {
                    wiki_page_id = Some(s.trim().to_string());
                }
            }
            _ => {}
        }
    }

    let data = file_bytes.ok_or_else(|| ApiError::unprocessable("file field is required"))?;
    if data.is_empty() {
        return Err(ApiError::bad_request("빈 파일은 업로드할 수 없습니다"));
    }
    if let Some(ref tid) = task_id {
        let t = state.db.tasks.get(tid)?;
        if t.as_ref().map(|x| x.project_id.as_str()) != Some(&access.project.id) {
            return Err(ApiError::not_found("Task not found"));
        }
    }
    if let Some(ref wid) = wiki_page_id {
        let p = state.db.wiki_pages.get(wid)?;
        if p.as_ref().map(|x| x.project_id.as_str()) != Some(&access.project.id) {
            return Err(ApiError::not_found("Page not found"));
        }
    }

    let ct = content_type
        .as_deref()
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_lowercase();
    if !ALLOWED_CONTENT_TYPES.contains(&ct.as_str()) {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            format!("지원하지 않는 파일 형식입니다: {ct}"),
        ));
    }

    let clean_name: String = StdPath::new(filename.as_deref().unwrap_or("file"))
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .chars()
        .take(200)
        .collect();
    let final_name = if clean_name.is_empty() {
        "file".into()
    } else {
        clean_name
    };

    let now = utcnow();
    let att = Attachment {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: access.project.id.clone(),
        filename: final_name,
        content_type: ct,
        size: data.len(),
        uploaded_by: user.id.clone(),
        task_id,
        wiki_page_id,
    };

    let dst = file_path(&state.settings.data_dir, &access.project.id, &att.id);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ApiError::internal(e.to_string()))?;
    }
    std::fs::write(&dst, &data).map_err(|e| ApiError::internal(e.to_string()))?;
    state.db.attachments.create(&att)?;

    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "attachment.uploaded",
        "attachment",
        &att.id,
        format!("첨부 업로드: {} ({}B)", att.filename, att.size),
        HashMap::new(),
    );
    Ok((StatusCode::CREATED, Json(to_read(att))))
}

async fn download_attachment(
    State(state): State<AppState>,
    Path((project_id, attachment_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<Response> {
    let access = require_project_access(&state, &project_id, &user)?;
    let att = state
        .db
        .attachments
        .get(&attachment_id)?
        .ok_or_else(|| ApiError::not_found("Attachment not found"))?;
    if att.project_id != access.project.id {
        return Err(ApiError::not_found("Attachment not found"));
    }
    let path = file_path(&state.settings.data_dir, &access.project.id, &att.id);
    let data = std::fs::read(&path).map_err(|_| ApiError::not_found("Attachment file missing"))?;

    let inline = INLINE_IMAGE_TYPES.contains(&att.content_type.as_str());
    let disposition = if inline { "inline" } else { "attachment" };
    let ascii_name: String = att
        .filename
        .chars()
        .filter(|c| c.is_ascii() && *c != '"' && *c != '\\' && !c.is_control())
        .collect();
    let ascii_fallback = if ascii_name.trim().is_empty() {
        "file"
    } else {
        ascii_name.trim()
    };
    let encoded = urlencoding::encode(&att.filename);
    let media = if inline {
        att.content_type.as_str()
    } else {
        "application/octet-stream"
    };

    let mut res = data.into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(media).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(cd) = HeaderValue::from_str(&format!(
        r#"{disposition}; filename="{ascii_fallback}"; filename*=UTF-8''{encoded}"#
    )) {
        h.insert(header::CONTENT_DISPOSITION, cd);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    Ok(res)
}

async fn delete_attachment(
    State(state): State<AppState>,
    Path((project_id, attachment_id)): Path<(String, String)>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    let access = require_project_access(&state, &project_id, &user)?;
    require_perm(&access, Permission::Delete)?;
    let att = state
        .db
        .attachments
        .get(&attachment_id)?
        .ok_or_else(|| ApiError::not_found("Attachment not found"))?;
    if att.project_id != access.project.id {
        return Err(ApiError::not_found("Attachment not found"));
    }
    let _ = std::fs::remove_file(file_path(&state.settings.data_dir, &access.project.id, &att.id));
    state.db.attachments.delete(&att.id)?;
    record_audit(
        &state.db,
        &access.project.id,
        &user.id,
        "attachment.deleted",
        "attachment",
        &att.id,
        format!("첨부 삭제: {}", att.filename),
        HashMap::new(),
    );
    Ok(StatusCode::NO_CONTENT)
}
