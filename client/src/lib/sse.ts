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

/**
 * Bearer 인증 + 401 자동 리프레시 + 지수 백오프 재연결을 지원하는 SSE 구독기.
 * 반환 함수를 호출하면 즉시 스트림을 종료한다.
 */
export function subscribeSSE(
  path: string,
  onMessage: (msg: SSEMessage) => void,
  onStatus?: (status: SSEStatus) => void,
  onReconnect?: () => void,
): () => void {
  let closed = false;
  let hasConnectedOnce = false;
  let lastEventId: string | undefined;
  let retryMs = 1000;
  let timer: number | undefined;
  let controller: AbortController | null = null;

  const scheduleReconnect = () => {
    if (closed) return;
    onStatus?.("reconnecting");
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, 15000);
    timer = window.setTimeout(connect, delay);
  };

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;

    try {
      const res = await fetchWithAuth(path, { method: "GET", headers, signal: controller.signal });
      if (closed) return;
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

      while (!closed) {
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
      if (!closed) scheduleReconnect();
    } catch (e) {
      if (closed || (e instanceof DOMException && e.name === "AbortError")) return;
      scheduleReconnect();
    }
  };

  const reconnectNow = () => {
    if (closed) return;
    if (timer) {
      window.clearTimeout(timer);
      timer = undefined;
      retryMs = 1000;
      connect();
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") reconnectNow();
  };
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", onVisible);
  connect();

  return () => {
    closed = true;
    window.removeEventListener("online", reconnectNow);
    document.removeEventListener("visibilitychange", onVisible);
    if (timer) window.clearTimeout(timer);
    controller?.abort();
  };
}
