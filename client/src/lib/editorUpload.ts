import { attachmentsApi } from "../api";
import { ApiError } from "../api/http";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function extractImageFile(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const file of Array.from(dt.files)) {
    if (ALLOWED_IMAGE_TYPES.has(file.type)) return file;
  }
  return null;
}

/** 이미지를 첨부 API 로 업로드하고 커서 위치에 Markdown 이미지 구문을 삽입한다. */
export async function insertUploadedImage(
  projectId: string,
  file: File,
  currentValue: string,
  textarea: HTMLTextAreaElement | null,
  onChange: (next: string) => void,
): Promise<void> {
  try {
    const att = await attachmentsApi.upload(projectId, file);
    const alt = att.filename.replace(/[\[\]]/g, "");
    const snippet = `![${alt}](${att.url})`;
    const start = textarea?.selectionStart ?? currentValue.length;
    const end = textarea?.selectionEnd ?? currentValue.length;
    const next = currentValue.slice(0, start) + snippet + currentValue.slice(end);
    onChange(next);
  } catch (e) {
    alert(e instanceof ApiError ? `이미지 업로드 실패: ${String(e.detail)}` : "이미지 업로드에 실패했습니다.");
  }
}
