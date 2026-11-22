import type { DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar } from "../../components/Avatar";
import { CheckSquareIcon, CommentIcon } from "../../components/icons";
import { dueState, formatDate } from "../../lib/time";
import type { PipelineStage, PipelineStageInfo, Task, User } from "../../types";
import { PRIORITY_META, STAGE_TONE } from "./tones";

interface Props {
  task: Task;
  taskKey: string; // 예: MW-12
  href: string;
  assignee: User | undefined;
  stages: PipelineStageInfo[];
  selected: boolean;
  compact?: boolean;
  checked?: boolean;
  onToggleCheck?: (taskId: string) => void;
  onMoveStage?: (taskId: string, stage: PipelineStage) => void;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}

const DUE_TONE = { overdue: "tone-err", soon: "tone-wait", ok: "" } as const;

/** 설명 첫 줄을 마크다운 기호 없이 */
function firstLine(md: string): string | undefined {
  return md
    .split("\n")
    .map((l) => l.replace(/^[\s#>*\-+]+|\[[ x]\]\s*|[*_`~]/g, "").trim())
    .find(Boolean);
}

/**
 * 일감 카드 — MightyCode "마이티 그래프 블록" 구조.
 * 우선순위(긴급/높음) 좌측 컬러 바, 마감 초과 강조, 컴팩트(밀집) 보기 지원.
 */
export function TaskCard({
  task,
  taskKey,
  href,
  assignee,
  stages,
  selected,
  compact = false,
  checked,
  onToggleCheck,
  onMoveStage,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}: Props) {
  const navigate = useNavigate();
  const priority = PRIORITY_META[task.priority];
  const running = task.stage === "in_progress";
  const due = dueState(task.due_date, task.stage === "done");
  const doneItems = task.checklist.filter((i) => i.done).length;
  const nextItem = task.checklist.find((i) => !i.done);
  const preview = nextItem ? `다음 할 일 · ${nextItem.text}` : firstLine(task.description);
  const stageLabel = stages.find((s) => s.key === task.stage)?.label ?? task.stage;
  const prioClass = task.priority === "urgent" ? "prio-urgent" : task.priority === "high" ? "prio-high" : "";

  return (
    <article
      className={`task-card ${STAGE_TONE[task.stage]} ${prioClass} ${due === "overdue" ? "is-overdue" : ""} ${running ? "is-running" : ""} ${compact ? "is-compact" : ""} ${selected ? "selected" : ""} ${checked ? "is-checked" : ""} ${dragging ? "is-dragging" : ""}`}
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => navigate(href)}
      onKeyDown={(e) => e.key === "Enter" && navigate(href)}
    >
      <header className="task-head">
        {onToggleCheck && (
          <input
            type="checkbox"
            className="task-select-cb"
            checked={!!checked}
            aria-label={`${taskKey} 선택`}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleCheck(task.id)}
          />
        )}
        <span className="task-tint" />
        <span className="task-key">{taskKey}</span>
        {running && !compact && (
          <span className="activity-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="spacer" />
        {onMoveStage ? (
          <>
            {!compact && <span className="pill desktop-stage-pill">{stageLabel}</span>}
            <select
              className="mobile-stage-select"
              value={task.stage}
              aria-label={`${taskKey} 단계 이동`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                onMoveStage(task.id, e.target.value as PipelineStage);
              }}
            >
              {stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          !compact && <span className="pill">{stageLabel}</span>
        )}
        {task.estimate != null && <span className="token">{task.estimate}pt</span>}
      </header>

      <div className="task-body">
        <div className="task-title">
          {priority && <span className={`pill ${priority.tone}`}>{priority.label}</span>}
          <span className="task-title-text">{task.title}</span>
        </div>
        {!compact && preview && <div className="task-preview">{preview}</div>}
        <div className="task-foot">
          {(assignee || !compact) && <Avatar user={assignee} size={compact ? 16 : 18} />}
          {(!compact || assignee) && (
            <span className="task-who">{assignee ? assignee.name || assignee.email : "미지정"}</span>
          )}
          {!compact && task.via_client && (
            <span className="pill tone-agent agent-via" title={`MCP 클라이언트(${task.via_client}) 출처`}>
              via {task.via_client}
            </span>
          )}
          <span className="spacer" />
          {task.subtask_count > 0 && (
            <span className={`badge ${task.subtask_done === task.subtask_count ? "tone-done" : ""}`} title="하위 일감">
              ↳ {task.subtask_done}/{task.subtask_count}
            </span>
          )}
          {task.checklist.length > 0 && (
            <span className={`badge ${doneItems === task.checklist.length ? "tone-done" : ""}`} title="할 일">
              <CheckSquareIcon size={11} /> {doneItems}/{task.checklist.length}
            </span>
          )}
          {!compact && task.comment_count > 0 && (
            <span className="badge" title="덧글">
              <CommentIcon size={11} /> {task.comment_count}
            </span>
          )}
          {task.due_date && (
            <span className={`badge ${due ? DUE_TONE[due] : ""}`} title={`종료일 ${task.due_date}`}>
              {formatDate(task.due_date)}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
