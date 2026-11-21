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

let refreshInFlight: Promise<string | null> | null = null;

/** 만료된 액세스 토큰을 HttpOnly 리프레시 쿠키로 조용히 갱신 (동시 401 은 하나로 합침) */
async function tryRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(BASE_URL + "/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as { access_token?: string };
        if (!data.access_token) return null;
        tokenStorage.set(data.access_token);
        return data.access_token;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function fetchWithAuth(path: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(BASE_URL + path, { ...init, credentials: "include", headers });
  };

  let res = await send(tokenStorage.get());
  if (res.status === 401 && !path.startsWith("/auth/")) {
    const nextToken = await tryRefresh();
    if (nextToken) {
      res = await send(nextToken);
    }
  }
  if (res.status === 401) {
    tokenStorage.clear();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return res;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithAuth(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.detail ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const http = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: "DELETE" }),
};

/** 파일 응답(Blob) + Content-Disposition 의 파일 이름 (RFC 5987 filename* 우선) */
export async function requestFile(path: string, init: RequestInit = {}): Promise<{ blob: Blob; filename: string }> {
  const res = await fetchWithAuth(path, init);
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
