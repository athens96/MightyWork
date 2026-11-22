import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { tasksApi, templatesApi } from "../api";
import { can } from "../lib/permissions";
import type { PipelineStage, Priority, Project, TaskTemplate } from "../types";
import { PRIORITY_LABEL } from "../features/tasks/tones";

export const TASK_CREATED_EVENT = "mightywork:task-created";

interface Props {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultProjectId: string | undefined;
}

/** 빠른 일감 생성 모달 (단축키 C) — MW-7 템플릿 자동 채우기 지원 */
export function QuickCreateModal({ open, onClose, projects, defaultProjectId }: Props) {
  const navigate = useNavigate();
  const writable = projects.filter((p) => can(p, "create"));
  const [projectId, setProjectId] = useState("");
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [selectedTpl, setSelectedTpl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState<PipelineStage>("backlog");
  const [priority, setPriority] = useState<Priority>("medium");
  const [version, setVersion] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [checklistItems, setChecklistItems] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const def = writable.find((p) => p.id === defaultProjectId)?.id ?? writable[0]?.id ?? "";
    setProjectId(def);
    setSelectedTpl("");
    setTitle("");
    setDescription("");
    setStage("backlog");
    setPriority("medium");
    setVersion("");
    setTagsText("");
    setChecklistItems([]);
    setDueDate("");
  }, [open, defaultProjectId]);

  useEffect(() => {
    if (!open || !projectId) return;
    templatesApi.list(projectId).then(setTemplates, () => setTemplates([]));
  }, [open, projectId]);

  const applyTemplate = (tplId: string) => {
    setSelectedTpl(tplId);
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) {
      setChecklistItems([]);
      return;
    }
    if (tpl.title_prefix && !title.startsWith(tpl.title_prefix)) {
      setTitle(tpl.title_prefix + title);
    }
    setDescription(tpl.description);
    setStage(tpl.stage);
    setPriority(tpl.priority);
    setTagsText(tpl.tags.join(", "));
    setChecklistItems(tpl.checklist);
  };

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || !title.trim() || busy) return;
    setBusy(true);
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await tasksApi.create(projectId, {
        title: title.trim(),
        description,
        stage,
        priority,
        version: version.trim() || null,
        tags,
        checklist: checklistItems.map((text) => ({ text, done: false })),
        due_date: dueDate || null,
      });
      window.dispatchEvent(new CustomEvent(TASK_CREATED_EVENT, { detail: created }));
      onClose();
      navigate(`/projects/${projectId}/tasks/${created.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="card quick-modal" role="dialog" aria-modal="true" aria-label="빠른 일감 생성" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="quick-head">
          <h3>새 일감 만들기</h3>
          <kbd>ESC</kbd>
        </div>
        {writable.length === 0 ? (
          <p className="muted">일감을 생성할 수 있는 프로젝트가 없습니다.</p>
        ) : (
          <>
            <div className="quick-row">
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setSelectedTpl("");
                }}
                aria-label="프로젝트"
              >
                {writable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
              {templates.length > 0 && (
                <select value={selectedTpl} onChange={(e) => applyTemplate(e.target.value)} aria-label="템플릿 선택">
                  <option value="">템플릿 선택…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      📋 {t.name}
                    </option>
                  ))}
                </select>
              )}
              <select value={stage} onChange={(e) => setStage(e.target.value as PipelineStage)} aria-label="단계">
                <option value="backlog">백로그</option>
                <option value="todo">할 일</option>
                <option value="in_progress">진행 중</option>
                <option value="review">코드 리뷰</option>
                <option value="qa">QA</option>
                <option value="done">완료</option>
              </select>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="우선순위">
                {(["urgent", "high", "medium", "low"] as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
              <input
                className="quick-version-input mono"
                value={version}
                maxLength={40}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="버전 (v0.1.0)"
                aria-label="버전"
              />
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="마감일" />
            </div>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="일감 제목" required />
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명 (Markdown · [[위키]] · @멘션)" />
            <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="레이블 (쉼표로 구분, 예: bug, frontend)" />
            {checklistItems.length > 0 && (
              <div className="quick-tpl-check">
                <span className="muted" style={{ fontSize: 11.5 }}>
                  템플릿 체크리스트 ({checklistItems.length}건 자동 추가):
                </span>
                <ul>
                  {checklistItems.map((c, idx) => (
                    <li key={idx}>☐ {c}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="quick-foot">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                취소
              </button>
              <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>
                {busy ? "생성 중…" : "일감 생성"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

/** 키보드 단축키 안내 모달 (단축키 ?) */
export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const rows: [string, string][] = [
    ["⌘K / Ctrl+K", "전역 커맨드 팔레트 (일감·위키 검색 및 이동)"],
    ["C", "빠른 일감 생성 모달 열기 (템플릿 지원)"],
    ["R", "현재 화면 데이터 즉시 새로고침"],
    ["/", "일감 보드·리스트 빠른 필터 포커스"],
    ["J / K (↓ / ↑)", "일감 보드·리스트 포커스 이동"],
    ["Enter / X", "포커스된 일감 열기 / 일괄 선택 토글"],
    ["?", "키보드 단축키 안내 열기"],
    ["1 ~ 4", "일감 상세: 우선순위 지정 (1 긴급 · 2 높음 · 3 보통 · 4 낮음)"],
    ["A", "일감 상세: 나에게 배정 / 배정 해제"],
    ["S", "일감 상세: 다음 파이프라인 단계로 이동"],
    ["Esc", "열려 있는 모달·상세 패널 닫기"],
    ["⌘S / Ctrl+S", "위키·일감 설명 저장"],
  ];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card quick-modal" role="dialog" aria-modal="true" aria-label="키보드 단축키" onClick={(e) => e.stopPropagation()}>
        <div className="quick-head">
          <h3>키보드 단축키</h3>
          <kbd>ESC</kbd>
        </div>
        <div className="shortcuts-grid">
          {rows.map(([k, desc]) => (
            <div key={k} className="shortcut-row">
              <kbd>{k}</kbd>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
