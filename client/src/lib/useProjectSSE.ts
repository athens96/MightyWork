import { useEffect, useRef, useState } from "react";
import { PROJECT_EVENT, type ProjectEventDetail, type SSEStatus } from "./sse";

export const PROJECT_SSE_RECONNECT_EVENT = "mightywork:project-sse-reconnect";
const PROJECT_SSE_STATUS_EVENT = "mightywork:project-sse-status";

let currentStatus: SSEStatus = "reconnecting";
let currentProjectId: string | undefined;

/** Layout 의 단일 SSE 연결이 상태·재연결·이벤트를 하위 화면(일감 보드·위키 등)으로 중계한다. */
export function publishSSEStatus(projectId: string | undefined, status: SSEStatus) {
  currentProjectId = projectId;
  currentStatus = status;
  window.dispatchEvent(new CustomEvent(PROJECT_SSE_STATUS_EVENT, { detail: { projectId, status } }));
}

export function publishProjectSSEReconnect(projectId: string) {
  window.dispatchEvent(new CustomEvent(PROJECT_SSE_RECONNECT_EVENT, { detail: { projectId } }));
}

/**
 * 현재 탭의 공유 프로젝트 SSE 스트림(Layout 관리)을 구독한다.
 * 개별 페이지가 별도 SSE 연결을 열지 않으므로 HTTP/1.1 6연결 한도 고갈을 방지한다.
 */
export function useProjectSSE(
  projectId: string,
  onEvent: (detail: ProjectEventDetail) => void,
  onReconnect?: () => void,
): SSEStatus {
  const [status, setStatus] = useState<SSEStatus>(() =>
    currentProjectId === projectId ? currentStatus : "reconnecting",
  );
  const handlersRef = useRef({ onEvent, onReconnect });
  handlersRef.current = { onEvent, onReconnect };

  useEffect(() => {
    setStatus(currentProjectId === projectId ? currentStatus : "reconnecting");

    const handleEvent = (e: Event) => {
      const detail = (e as CustomEvent<ProjectEventDetail>).detail;
      if (detail?.projectId === projectId) {
        handlersRef.current.onEvent(detail);
      }
    };
    const handleStatus = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string; status: SSEStatus }>).detail;
      if (detail?.projectId === projectId) {
        setStatus(detail.status);
      }
    };
    const handleReconnect = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string }>).detail;
      if (detail?.projectId === projectId) {
        handlersRef.current.onReconnect?.();
      }
    };

    window.addEventListener(PROJECT_EVENT, handleEvent);
    window.addEventListener(PROJECT_SSE_STATUS_EVENT, handleStatus);
    window.addEventListener(PROJECT_SSE_RECONNECT_EVENT, handleReconnect);
    return () => {
      window.removeEventListener(PROJECT_EVENT, handleEvent);
      window.removeEventListener(PROJECT_SSE_STATUS_EVENT, handleStatus);
      window.removeEventListener(PROJECT_SSE_RECONNECT_EVENT, handleReconnect);
    };
  }, [projectId]);

  return status;
}
