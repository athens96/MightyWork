import { useNavigate } from "react-router-dom";
import { Avatar } from "../../components/Avatar";
import { CheckSquareIcon, CommentIcon } from "../../components/icons";
import { dueState, formatDate } from "../../lib/time";
import type { PipelineStageInfo, Task, User } from "../../types";
import { PRIORITY_META, STAGE_TONE } from "./tones";

interface Props {
  task: Task;
  taskKey: string; // 예: MW-12
  href: string;
  assignee: User | undefined;
  stages: PipelineStageInfo[];
  selected: boolean;
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
 * 일감 카드 — MightyCode "마이티 그래프 블록" 구조 (카드 시안 A 선택).
 * 머리줄(톤 표시·키·활동 막대·상태·추정치) → 제목 → 미리보기(다음 할 일/설명) → 작업자·배지.
 * 진행 중이면 run 색 점선이 흐르는 외곽선 + 후광.
 */
export function TaskCard({ task, taskKey, href, assignee, stages, selected }: Props) {
  const navigate = useNavigate();
  const priority = PRIORITY_META[task.priority];
  const running = task.stage === "in_progress";
  const due = dueState(task.due_date, task.stage === "done");
  const doneItems = task.checklist.filter((i) => i.done).length;
  const nextItem = task.checklist.find((i) => !i.done);
  const preview = nextItem ? `다음 할 일 · ${nextItem.text}` : firstLine(task.description);
  const stageLabel = stages.find((s) => s.key === task.stage)?.label ?? task.stage;

  return (
    <article
      className={`task-card ${STAGE_TONE[task.stage]} ${running ? "is-running" : ""} ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => navigate(href)}
      onKeyDown={(e) => e.key === "Enter" && navigate(href)}
    >
      <header className="task-head">
        <span className="task-tint" />
        <span className="task-key">{taskKey}</span>
        {running && (
          <span className="activity-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="spacer" />
        <span className="pill">{stageLabel}</span>
        {task.estimate != null && <span className="token">{task.estimate}pt</span>}
      </header>

      <div className="task-body">
        <div className="task-title">
          {priority && <span className={`pill ${priority.tone}`}>{priority.label}</span>}
          {task.title}
        </div>
        {preview && <div className="task-preview">{preview}</div>}
        <div className="task-foot">
          <Avatar user={assignee} size={18} />
          <span className="task-who">{assignee ? assignee.name || assignee.email : "미지정"}</span>
          <span className="spacer" />
          {task.checklist.length > 0 && (
            <span className={`badge ${doneItems === task.checklist.length ? "tone-done" : ""}`} title="할 일">
              <CheckSquareIcon size={11} /> {doneItems}/{task.checklist.length}
            </span>
          )}
          {task.comment_count > 0 && (
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
