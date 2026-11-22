import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../../components/Avatar";
import { ChevronIcon } from "../../components/icons";
import { groupTasks, partitionDoneByMonth, type DoneDisplayMode, type GroupBy, type MonthBucket } from "../../lib/taskGrouping";
import { dueState, formatDate } from "../../lib/time";
import type { Cycle, Milestone, PipelineStage, PipelineStageInfo, Task, User } from "../../types";
import { PRIORITY_LABEL, PRIORITY_META, STAGE_TONE } from "./tones";

const DUE_TONE = { overdue: "tone-err", soon: "tone-wait", ok: "" } as const;

interface Props {
  projectId: string;
  projectKey: string;
  tasks: Task[];
  stages: PipelineStageInfo[];
  usersById: Map<string, User>;
  milestones?: Milestone[];
  cycles?: Cycle[];
  groupBy?: GroupBy;
  doneMode?: DoneDisplayMode;
  compact?: boolean;
  canEdit: boolean;
  focusedTaskId?: string | null;
  selectedIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  onToggleAll?: (checked: boolean, visibleIds: string[]) => void;
  onMoveStage: (taskId: string, stage: PipelineStage) => void;
}

/** 일감 리스트(표) 뷰 — 단계/우선순위/작업자/마일스톤/사이클 그룹 아코디언 + 완료 월별 묶기 + 컴팩트 모드 */
export function TaskListView({
  projectId,
  projectKey,
  tasks,
  stages,
  usersById,
  milestones = [],
  cycles = [],
  groupBy = "stage",
  doneMode = "monthly",
  compact = false,
  canEdit,
  focusedTaskId,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onMoveStage,
}: Props) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(() => new Set());

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleBucket = (key: string) => {
    setExpandedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 완료 표시 모드 적용: 이전 달 완료 일감은 접이식 월별 묶음으로 분리
  const { activeOrVisible, doneBuckets, hiddenDoneCount } = useMemo(() => {
    const doneTasks = tasks.filter((t) => t.stage === "done");
    const part = partitionDoneByMonth(doneTasks, doneMode);
    if (doneMode === "hide") {
      return {
        activeOrVisible: tasks.filter((t) => t.stage !== "done"),
        doneBuckets: [] as MonthBucket[],
        hiddenDoneCount: part.hiddenCount,
      };
    }
    if (doneMode === "all" || part.buckets.length === 0) {
      return {
        activeOrVisible: tasks,
        doneBuckets: [] as MonthBucket[],
        hiddenDoneCount: 0,
      };
    }
    const bucketTaskIds = new Set(part.buckets.flatMap((b) => b.tasks.map((t) => t.id)));
    return {
      activeOrVisible: tasks.filter((t) => !bucketTaskIds.has(t.id)),
      doneBuckets: part.buckets,
      hiddenDoneCount: 0,
    };
  }, [tasks, doneMode]);

  const groups = useMemo(() => {
    const base = groupTasks(activeOrVisible, groupBy, { stages, usersById, milestones, cycles });
    // 단계별 그룹핑인데 이번 달 완료가 0건이고 이전 달 완료 묶음만 있을 때도 '완료' 그룹을 노출
    if (groupBy === "stage" && doneBuckets.length > 0 && !base.some((g) => g.isDoneGroup)) {
      const doneStage = stages.find((s) => s.key === "done");
      base.push({
        key: "done",
        label: doneStage?.label ?? "완료",
        tone: doneStage?.color || STAGE_TONE.done,
        tasks: [],
        isDoneGroup: true,
      });
    }
    return base;
  }, [activeOrVisible, groupBy, stages, usersById, milestones, cycles, doneBuckets.length]);

  if (tasks.length === 0) {
    return <div className="card empty">조건에 맞는 일감이 없습니다.</div>;
  }

  if (activeOrVisible.length === 0 && doneBuckets.length === 0 && hiddenDoneCount > 0) {
    return <div className="card empty">진행 중인 일감이 없습니다. (완료된 일감 {hiddenDoneCount}건 숨김 중)</div>;
  }

  const selectable = !!(canEdit && selectedIds && onToggleSelect && onToggleAll);
  const colSpan = selectable ? 9 : 8;
  const visibleRowIds = useMemo(() => {
    const ids = activeOrVisible.map((t) => t.id);
    const prefix = groupBy === "none" ? "flat" : groupBy === "stage" ? "stage-done" : "tail";
    for (const b of doneBuckets) {
      if (expandedBuckets.has(`${prefix}:${b.key}`)) {
        for (const t of b.tasks) ids.push(t.id);
      }
    }
    return ids;
  }, [activeOrVisible, doneBuckets, expandedBuckets, groupBy]);
  const allChecked = selectable && visibleRowIds.length > 0 && visibleRowIds.every((id) => selectedIds.has(id));

  const renderTaskRow = (t: Task) => {
    const assignee = t.assignee_id ? usersById.get(t.assignee_id) : undefined;
    const due = dueState(t.due_date, t.stage === "done");
    const prio = PRIORITY_META[t.priority];
    const isChecked = selectable && selectedIds.has(t.id);
    const prioClass = t.priority === "urgent" ? "prio-urgent" : t.priority === "high" ? "prio-high" : "";
    return (
      <tr
        key={t.id}
        data-task-id={t.id}
        className={`${isChecked ? "is-checked" : ""} ${focusedTaskId === t.id ? "is-kbd-focus" : ""} ${prioClass} ${due === "overdue" ? "is-overdue" : ""}`}
      >
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
          {!compact && t.tags.length > 0 && (
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
          {t.version ? <span className="version-badge">{t.version}</span> : <span className="muted">—</span>}
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
  };

  const renderMonthBuckets = (prefix: string) =>
    doneBuckets.map((bucket) => {
      const bKey = `${prefix}:${bucket.key}`;
      const open = expandedBuckets.has(bKey);
      return (
        <Fragment key={bKey}>
          <tr className="list-bucket-row">
            <td colSpan={colSpan}>
              <button type="button" className="list-bucket-btn" aria-expanded={open} onClick={() => toggleBucket(bKey)}>
                <ChevronIcon size={11} className={open ? "is-open" : ""} />
                <span>{bucket.label} 완료</span>
                <span className="pill tone-done">{bucket.tasks.length}건</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {open ? "접기" : "펼쳐 보기"}
                </span>
              </button>
            </td>
          </tr>
          {open && bucket.tasks.map(renderTaskRow)}
        </Fragment>
      );
    });

  return (
    <div className="card list-view-card">
      <table className={`index-table task-list-table ${compact ? "is-compact" : ""}`}>
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => onToggleAll(e.target.checked, visibleRowIds)}
                  aria-label="전체 선택"
                />
              </th>
            )}
            <th>키</th>
            <th>제목</th>
            <th>버전</th>
            <th>단계</th>
            <th>우선순위</th>
            <th>작업자</th>
            <th>마감일</th>
            <th>추정</th>
          </tr>
        </thead>
        <tbody>
          {groupBy === "none" ? (
            <>
              {activeOrVisible.map(renderTaskRow)}
              {doneBuckets.length > 0 && renderMonthBuckets("flat")}
            </>
          ) : (
            <>
              {groups.map((g) => {
                const collapsed = collapsedGroups.has(g.key);
                const extraDoneCount = g.isDoneGroup ? doneBuckets.reduce((sum, b) => sum + b.tasks.length, 0) : 0;
                const totalCount = g.tasks.length + extraDoneCount;
                return (
                  <Fragment key={g.key}>
                    <tr className={`list-group-row ${g.tone ?? ""}`}>
                      <td colSpan={colSpan}>
                        <button type="button" className="list-group-btn" aria-expanded={!collapsed} onClick={() => toggleGroup(g.key)}>
                          <ChevronIcon size={11} className={!collapsed ? "is-open" : ""} />
                          {g.tone && <span className="dot" />}
                          <strong>{g.label}</strong>
                          <span className="mono muted">{totalCount}건</span>
                          {g.isDoneGroup && extraDoneCount > 0 && (
                            <span className="muted" style={{ fontSize: 11 }}>
                              (이번 달 {g.tasks.length} · 이전 {extraDoneCount} 묶음)
                            </span>
                          )}
                        </button>
                      </td>
                    </tr>
                    {!collapsed && (
                      <>
                        {g.tasks.map(renderTaskRow)}
                        {g.isDoneGroup && doneBuckets.length > 0 && renderMonthBuckets("stage-done")}
                      </>
                    )}
                  </Fragment>
                );
              })}
              {groupBy !== "stage" && doneBuckets.length > 0 && (
                <>
                  <tr className="list-group-row tone-done">
                    <td colSpan={colSpan}>
                      <div className="list-group-btn" style={{ cursor: "default" }}>
                        <span className="dot" />
                        <strong>이전 기간 완료 묶음</strong>
                        <span className="mono muted">{doneBuckets.reduce((s, b) => s + b.tasks.length, 0)}건</span>
                      </div>
                    </td>
                  </tr>
                  {renderMonthBuckets("tail")}
                </>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
