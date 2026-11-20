const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "") + "/api";
const TOKEN_KEY = "mightywork.token";

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** 401 응답 시 발생 — AuthContext 가 구독해서 로그아웃 처리 */
export const UNAUTHORIZED_EVENT = "mightywork:unauthorized";

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : `Request failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const token = tokenStorage.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(BASE_URL + path, { ...init, headers });

  if (res.status === 401) {
    tokenStorage.clear();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.detail ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const http = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: "DELETE" }),
};

/** 파일 응답(Blob) + Content-Disposition 의 파일 이름 (RFC 5987 filename* 우선) */
export async function requestFile(path: string, init: RequestInit = {}): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers(init.headers);
  const token = tokenStorage.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(BASE_URL + path, { ...init, headers });
  if (res.status === 401) {
    tokenStorage.clear();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.detail ?? res.statusText);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  const plain = /filename="([^"]+)"/i.exec(cd)?.[1];
  return { blob: await res.blob(), filename: star ? decodeURIComponent(star) : plain ?? "download" };
}

/** multipart 업로드 (Content-Type 은 브라우저가 boundary 와 함께 설정) */
export function upload<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: "POST", body: form });
}

/** 브라우저 다운로드 실행 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
