import { Link } from "react-router-dom";
import { Avatar } from "../../components/Avatar";
import { dueState, formatDate } from "../../lib/time";
import type { PipelineStage, PipelineStageInfo, Task, User } from "../../types";
import { PRIORITY_LABEL, PRIORITY_META, STAGE_TONE } from "./tones";

const DUE_TONE = { overdue: "tone-err", soon: "tone-wait", ok: "" } as const;

interface Props {
  projectId: string;
  projectKey: string;
  tasks: Task[];
  stages: PipelineStageInfo[];
  usersById: Map<string, User>;
  canEdit: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  onToggleAll?: (checked: boolean) => void;
  onMoveStage: (taskId: string, stage: PipelineStage) => void;
}

/** 일감 리스트(표) 뷰 — 백로그 대량 정리·스캔·다중 선택용 */
export function TaskListView({
  projectId,
  projectKey,
  tasks,
  stages,
  usersById,
  canEdit,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onMoveStage,
}: Props) {
  if (tasks.length === 0) {
    return <div className="card empty">조건에 맞는 일감이 없습니다.</div>;
  }

  const selectable = !!(canEdit && selectedIds && onToggleSelect && onToggleAll);
  const allChecked = selectable && tasks.length > 0 && tasks.every((t) => selectedIds.has(t.id));

  return (
    <div className="card list-view-card">
      <table className="index-table task-list-table">
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  aria-label="전체 선택"
                />
              </th>
            )}
            <th>키</th>
            <th>제목</th>
            <th>단계</th>
            <th>우선순위</th>
            <th>작업자</th>
            <th>마감일</th>
            <th>추정</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const assignee = t.assignee_id ? usersById.get(t.assignee_id) : undefined;
            const due = dueState(t.due_date, t.stage === "done");
            const prio = PRIORITY_META[t.priority];
            const isChecked = selectable && selectedIds.has(t.id);
            return (
              <tr key={t.id} className={isChecked ? "is-checked" : undefined}>
                {selectable && (
                  <td className="nowrap">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => onToggleSelect(t.id)}
                      aria-label={`${projectKey}-${t.number} 선택`}
                    />
                  </td>
                )}
                <td className="nowrap">
                  <Link to={`/projects/${projectId}/tasks/${t.id}`} className={`key-badge ${STAGE_TONE[t.stage]}`}>
                    {projectKey}-{t.number}
                  </Link>
                </td>
                <td>
                  <Link to={`/projects/${projectId}/tasks/${t.id}`} className="index-title">
                    {t.title}
                  </Link>
                  {t.subtask_count > 0 && (
                    <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                      ↳ {t.subtask_done}/{t.subtask_count}
                    </span>
                  )}
                  {t.tags.length > 0 && (
                    <span className="list-tags">
                      {t.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="nowrap">
                  {canEdit ? (
                    <select
                      className={`inline-stage-select ${STAGE_TONE[t.stage]}`}
                      value={t.stage}
                      onChange={(e) => onMoveStage(t.id, e.target.value as PipelineStage)}
                      aria-label={`${projectKey}-${t.number} 단계`}
                    >
                      {stages.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={`pill ${STAGE_TONE[t.stage]}`}>
                      {stages.find((s) => s.key === t.stage)?.label ?? t.stage}
                    </span>
                  )}
                </td>
                <td className="nowrap">
                  {prio ? <span className={`pill ${prio.tone}`}>{prio.label}</span> : <span className="muted">{PRIORITY_LABEL[t.priority]}</span>}
                </td>
                <td className="nowrap">
                  {assignee ? (
                    <span className="props-owner">
                      <Avatar user={assignee} size={16} /> {assignee.name || assignee.email}
                    </span>
                  ) : (
                    <span className="muted">미지정</span>
                  )}
                </td>
                <td className="nowrap">
                  {t.due_date ? (
                    <span className={`badge ${due ? DUE_TONE[due] : ""}`}>{formatDate(t.due_date)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="nowrap muted">{t.estimate != null ? `${t.estimate}pt` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
