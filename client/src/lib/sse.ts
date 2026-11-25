import { fetchWithAuth } from "../api/http";

export interface SSEMessage {
  id?: string;
  event: string;
  data: Record<string, unknown>;
}

export type SSEStatus = "connected" | "reconnecting";

export const PROJECT_EVENT = "mightywork:project-event";

export interface ProjectEventDetail {
  projectId: string;
  event: string;
  data: Record<string, unknown>;
}

/**
 * SSE 텍스트 버퍼에서 완성된 프레임들을 파싱하고 남은 잔여 버퍼를 반환한다.
 * (W3C EventSource 프레임 규격: 빈 줄 구분, id/event/data 필드, ':' 주석 무시)
 */
export function parseSSEBuffer(buffer: string): { messages: SSEMessage[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const messages: SSEMessage[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let event = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const rawValue = colon === -1 ? "" : line.slice(colon + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "id") id = value;
      else if (field === "event") event = value || "message";
      else if (field === "data") dataLines.push(value);
    }

    if (dataLines.length === 0) continue;
    const rawData = dataLines.join("\n");
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawData);
      data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      data = { raw: rawData };
    }
    messages.push({ id, event, data });
  }

  return { messages, rest };
}

export interface SSEOptions {
  /** 백그라운드(hidden) 탭에서 지정 ms 경과 시 SSE 연결을 일시 중지해 HTTP/1.1 연결 고갈 방지 (0 이면 비활성화, 기본 5000ms) */
  pauseWhenHiddenMs?: number;
}

const DEFAULT_HIDDEN_PAUSE_MS = 5_000;

/**
 * Bearer 인증 + 401 자동 리프레시 + 지수 백오프 재연결 + 백그라운드 탭 절전을 지원하는 SSE 구독기.
 * 반환 함수를 호출하면 즉시 스트림을 종료한다.
 */
export function subscribeSSE(
  path: string,
  onMessage: (msg: SSEMessage) => void,
  onStatus?: (status: SSEStatus) => void,
  onReconnect?: () => void,
  options: SSEOptions = {},
): () => void {
  const pauseWhenHiddenMs = options.pauseWhenHiddenMs ?? DEFAULT_HIDDEN_PAUSE_MS;
  let closed = false;
  let hasConnectedOnce = false;
  let pausedForHidden = false;
  let lastEventId: string | undefined;
  let retryMs = 1000;
  let timer: number | undefined;
  let hideTimer: number | undefined;
  let controller: AbortController | null = null;

  const isHidden = () =>
    pauseWhenHiddenMs > 0 && typeof document !== "undefined" && document.visibilityState === "hidden";

  const clearTimers = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    if (isHidden()) {
      pausedForHidden = true;
      return;
    }
    onStatus?.("reconnecting");
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, 15000);
    timer = window.setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    if (isHidden()) {
      pausedForHidden = true;
      return;
    }
    pausedForHidden = false;
    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;

    try {
      const res = await fetchWithAuth(path, { method: "GET", headers, signal: myController.signal });
      if (closed || controller !== myController) return;
      if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403 || res.status === 404) return;
        scheduleReconnect();
        return;
      }

      retryMs = 1000;
      const reconnected = hasConnectedOnce;
      hasConnectedOnce = true;
      onStatus?.("connected");
      if (reconnected) onReconnect?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed && controller === myController) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { messages, rest } = parseSSEBuffer(buffer);
        buffer = rest;
        for (const msg of messages) {
          if (msg.id) lastEventId = msg.id;
          if (msg.event !== "connected") onMessage(msg);
        }
      }
      if (!closed && controller === myController && !pausedForHidden) scheduleReconnect();
    } catch (e) {
      if (closed || pausedForHidden || controller !== myController || (e instanceof DOMException && e.name === "AbortError")) return;
      scheduleReconnect();
    }
  };

  const resumeIfNeeded = () => {
    if (closed) return;
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
    if (pausedForHidden) {
      pausedForHidden = false;
      retryMs = 1000;
      void connect();
      return;
    }
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
      retryMs = 1000;
      void connect();
    }
  };

  const onVisibilityChange = () => {
    if (closed) return;
    if (document.visibilityState === "visible") {
      resumeIfNeeded();
    } else if (pauseWhenHiddenMs > 0) {
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        hideTimer = undefined;
        if (closed || document.visibilityState !== "hidden") return;
        pausedForHidden = true;
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
        controller?.abort();
        controller = null;
      }, pauseWhenHiddenMs);
    }
  };

  const onOnline = () => {
    if (!isHidden()) resumeIfNeeded();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (isHidden()) {
    pausedForHidden = true;
  } else {
    void connect();
  }

  return () => {
    closed = true;
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    clearTimers();
    controller?.abort();
    controller = null;
  };
}
