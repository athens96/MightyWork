import { useState, type KeyboardEvent } from "react";
import { Avatar } from "../../components/Avatar";
import { CloseIcon, TrashIcon } from "../../components/icons";
import { dueState, timeAgo } from "../../lib/time";
import type { Cycle, Milestone, PipelineStageInfo, Priority, Task, TaskUpdate, User } from "../../types";
import { PRIORITY_LABEL, STAGE_TONE } from "./tones";

interface Props {
  task: Task;
  stages: PipelineStageInfo[];
  cycles?: Cycle[];
  milestones?: Milestone[];
  users: User[]; // 보고자 등 표시용
  assignees: User[]; // 작업자 후보 (프로젝트 멤버)
  readOnly: boolean; // 편집 권한 없음
  canDelete: boolean;
  onPatch: (body: TaskUpdate) => void;
  onDelete: () => void;
}

/** 오른쪽 속성 사이드바 — 설정 행 패턴(이름 왼쪽, 컨트롤 오른쪽), 바꾸면 즉시 저장 */
export function TaskProperties({ task, stages, cycles = [], milestones = [], users, assignees, readOnly, canDelete, onPatch, onDelete }: Props) {
  const [estimate, setEstimate] = useState(task.estimate?.toString() ?? "");
  const [tagDraft, setTagDraft] = useState("");
  const reporter = users.find((u) => u.id === task.created_by);
  const assignee = users.find((u) => u.id === task.assignee_id);
  const due = dueState(task.due_date, task.stage === "done");

  const commitEstimate = () => {
    const value = estimate.trim() === "" ? null : Number(estimate);
    if (value !== task.estimate && (value === null || Number.isInteger(value))) onPatch({ estimate: value });
  };

  const addTag = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const tag = tagDraft.trim();
    if (tag && !task.tags.includes(tag)) onPatch({ tags: [...task.tags, tag] });
    setTagDraft("");
  };

  return (
    <aside className="props">
      <fieldset className="props-fields" disabled={readOnly}>
      <div className="prop">
        <span className="prop-name">상태</span>
        <span className={`prop-control with-dot ${STAGE_TONE[task.stage]}`}>
          <span className="dot" />
          <select value={task.stage} onChange={(e) => onPatch({ stage: e.target.value as Task["stage"] })}>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="prop">
        <span className="prop-name">우선순위</span>
        <select className="prop-control" value={task.priority} onChange={(e) => onPatch({ priority: e.target.value as Priority })}>
          {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="prop">
        <span className="prop-name">작업자</span>
        <span className="prop-control with-dot">
          <Avatar user={assignee} size={18} />
          <select value={task.assignee_id ?? ""} onChange={(e) => onPatch({ assignee_id: e.target.value || null })}>
            <option value="">미지정</option>
            {assignee && !assignees.some((u) => u.id === assignee.id) && <option value={assignee.id}>{assignee.name || assignee.email}</option>}
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
        </span>
      </div>

      {cycles.length > 0 && (
        <div className="prop">
          <span className="prop-name">사이클</span>
          <select className="prop-control" value={task.cycle_id ?? ""} onChange={(e) => onPatch({ cycle_id: e.target.value || null })}>
            <option value="">미지정</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.status === "active" ? "● " : ""}
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {milestones.length > 0 && (
        <div className="prop">
          <span className="prop-name">마일스톤</span>
          <select className="prop-control" value={task.milestone_id ?? ""} onChange={(e) => onPatch({ milestone_id: e.target.value || null })}>
            <option value="">미지정</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="prop">
        <span className="prop-name">시작일</span>
        <input
          className="prop-control"
          type="date"
          value={task.start_date ?? ""}
          max={task.due_date ?? undefined}
          onChange={(e) => onPatch({ start_date: e.target.value || null })}
        />
      </div>

      <div className="prop">
        <span className="prop-name">종료일</span>
        <input
          className={`prop-control ${due === "overdue" ? "is-overdue" : ""}`}
          type="date"
          value={task.due_date ?? ""}
          min={task.start_date ?? undefined}
          onChange={(e) => onPatch({ due_date: e.target.value || null })}
          title={due === "overdue" ? "종료일이 지났습니다" : undefined}
        />
      </div>

      <div className="prop">
        <span className="prop-name">추정치</span>
        <span className="prop-control with-suffix">
          <input
            type="number"
            min={0}
            max={100}
            value={estimate}
            placeholder="—"
            onChange={(e) => setEstimate(e.target.value)}
            onBlur={commitEstimate}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="suffix">pt</span>
        </span>
      </div>

      <div className="prop prop-tags">
        <span className="prop-name">레이블</span>
        <div className="tag-editor">
          {task.tags.map((tag) => (
            <span key={tag} className="tag removable">
              {tag}
              {!readOnly && (
                <button onClick={() => onPatch({ tags: task.tags.filter((t) => t !== tag) })} aria-label={`${tag} 제거`}>
                  <CloseIcon size={9} />
                </button>
              )}
            </span>
          ))}
          {!readOnly && <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={addTag} placeholder="추가 후 Enter" />}
          {readOnly && task.tags.length === 0 && <span className="muted">없음</span>}
        </div>
      </div>

      </fieldset>
      {readOnly && <p className="props-note">편집 권한이 없어 읽기만 가능합니다.</p>}

      <div className="prop-divider" />

      <div className="prop">
        <span className="prop-name">보고자</span>
        <span className="prop-value">
          <Avatar user={reporter} size={18} /> {reporter?.name || reporter?.email || "알 수 없음"}
        </span>
      </div>
      <div className="prop">
        <span className="prop-name">생성</span>
        <span className="prop-value muted">{timeAgo(task.created_at)}</span>
      </div>
      <div className="prop">
        <span className="prop-name">수정</span>
        <span className="prop-value muted">{timeAgo(task.updated_at)}</span>
      </div>

      {canDelete && (
        <button className="btn btn-sm btn-danger props-delete" onClick={onDelete}>
          <TrashIcon size={12} /> 일감 삭제
        </button>
      )}
    </aside>
  );
}
