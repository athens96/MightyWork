import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { releasesApi, wikiApi } from "../../api";
import { saveBlob } from "../../api/http";
import { ChevronIcon, DocIcon } from "../../components/icons";
import { RefreshButton } from "../../components/RefreshButton";
import { can as canDo } from "../../lib/permissions";
import { timeAgo } from "../../lib/time";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import type { PipelineStage, Project, ReleaseChangelogResponse, ReleaseStatus, ReleaseSummary } from "../../types";
import { PRIORITY_META, STAGE_TONE } from "../tasks/tones";

const STATUS_META: Record<ReleaseStatus, { label: string; tone: string }> = {
  released: { label: "릴리즈 완료", tone: "tone-done" },
  in_progress: { label: "진행 중", tone: "tone-run" },
  planned: { label: "계획됨", tone: "tone-wait" },
};

const STAGE_LABEL: Record<PipelineStage, string> = {
  backlog: "백로그",
  todo: "할 일",
  in_progress: "진행 중",
  review: "코드 리뷰",
  qa: "QA",
  done: "완료",
};

/** 버전별 릴리즈 진행 현황 대시보드 + 체인지로그(Markdown) 자동 생성·복사·다운로드·위키 저장 */
export function ReleasesSection({ project }: { project: Project }) {
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [unversionedCount, setUnversionedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => new Set());
  const [openChangelogVer, setOpenChangelogVer] = useState<string | null>(null);
  const [includeUnfinished, setIncludeUnfinished] = useState(false);
  const [changelog, setChangelog] = useState<ReleaseChangelogResponse | null>(null);
  const [changelogBusy, setChangelogBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedWikiId, setSavedWikiId] = useState<string | null>(null);
  const [savingWiki, setSavingWiki] = useState(false);

  const canCreate = canDo(project, "create");

  const reload = useCallback(
    async (showLoader = false) => {
      if (showLoader) setLoading(true);
      try {
        const res = await releasesApi.list(project.id);
        setReleases(res.releases);
        setUnversionedCount(res.unversioned_count);
      } finally {
        if (showLoader) setLoading(false);
      }
    },
    [project.id],
  );

  useEffect(() => {
    void reload(true);
  }, [reload]);

  const { refreshing, lastUpdated, refresh } = useAutoRefresh(() => reload(false), {
    intervalMs: 30_000,
    shortcutKey: true,
  });

  const loadChangelog = useCallback(
    async (version: string, withUnfinished: boolean) => {
      setChangelogBusy(true);
      setCopied(false);
      setSavedWikiId(null);
      try {
        const res = await releasesApi.changelog(project.id, version, withUnfinished);
        setChangelog(res);
      } finally {
        setChangelogBusy(false);
      }
    },
    [project.id],
  );

  const toggleChangelog = (version: string) => {
    if (openChangelogVer === version) {
      setOpenChangelogVer(null);
      setChangelog(null);
      return;
    }
    setOpenChangelogVer(version);
    void loadChangelog(version, includeUnfinished);
  };

  const toggleUnfinished = (checked: boolean) => {
    setIncludeUnfinished(checked);
    if (openChangelogVer) {
      void loadChangelog(openChangelogVer, checked);
    }
  };

  const toggleExpandTasks = (version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const copyMarkdown = async () => {
    if (!changelog) return;
    await navigator.clipboard?.writeText(changelog.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const downloadMarkdown = () => {
    if (!changelog) return;
    const blob = new Blob([changelog.markdown], { type: "text/markdown;charset=utf-8" });
    saveBlob(blob, `CHANGELOG-${changelog.version}.md`);
  };

  const saveToWiki = async () => {
    if (!changelog || savingWiki) return;
    setSavingWiki(true);
    try {
      const title = `릴리즈 노트 ${changelog.version}`;
      const created = await wikiApi.create(project.id, { title, content: changelog.markdown });
      await wikiApi.update(project.id, created.id, {
        page_type: "reference",
        status: "published",
        tags: ["release-notes", changelog.version],
      });
      setSavedWikiId(created.id);
    } finally {
      setSavingWiki(false);
    }
  };

  const releasedCount = releases.filter((r) => r.status === "released").length;
  const activeCount = releases.filter((r) => r.status === "in_progress").length;

  return (
    <div>
      <section className="tiles">
        <div className="tile fill-run">
          <span className="tile-num">{activeCount}</span>
          <span className="tile-label">진행 중 버전</span>
        </div>
        <div className="tile text-done">
          <span className="tile-num">{releasedCount}</span>
          <span className="tile-label">릴리즈 완료</span>
        </div>
        <div className="tile">
          <span className="tile-num">{releases.length}</span>
          <span className="tile-label">전체 버전</span>
        </div>
        <Link to={`/projects/${project.id}/tasks?ver=none`} className="tile" title="버전이 지정되지 않은 일감 보기">
          <span className="tile-num">{unversionedCount}</span>
          <span className="tile-label">버전 미지정 →</span>
        </Link>
      </section>

      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>릴리즈 · 버전 대시보드</h2>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
            일감의 버전 필드를 기준으로 릴리즈 진행률을 추적하고 배포용 체인지로그(Markdown)를 자동 생성합니다.
          </p>
        </div>
        <RefreshButton refreshing={refreshing} lastUpdated={lastUpdated} onClick={refresh} shortcut />
      </div>

      {loading ? (
        <p className="muted">버전 현황 불러오는 중…</p>
      ) : releases.length === 0 ? (
        <div className="card empty">
          아직 버전이 지정된 일감이 없습니다. 일감 상세 패널이나 일괄 편집에서 버전(예: <code>v0.1.0</code>)을 지정해 보세요.
        </div>
      ) : (
        <div className="cycle-list">
          {releases.map((r) => {
            const meta = STATUS_META[r.status];
            const isExpanded = expandedVersions.has(r.version);
            const isChangelogOpen = openChangelogVer === r.version;
            return (
              <article key={r.version} className={`card cycle-card ${r.status === "in_progress" ? "is-active" : ""}`}>
                <div className="cycle-card-head">
                  <div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <span className="version-badge" style={{ height: 22, fontSize: 12, padding: "0 8px" }}>
                        {r.version}
                      </span>
                      <span className={`pill ${meta.tone}`}>{meta.label}</span>
                      {r.latest_updated_at && (
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          최근 갱신 {timeAgo(r.latest_updated_at)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <Link to={`/projects/${project.id}/tasks?ver=${encodeURIComponent(r.version)}`} className="btn btn-sm btn-ghost">
                      보드에서 보기 ({r.total_tasks})
                    </Link>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpandTasks(r.version)}
                    >
                      <ChevronIcon size={10} className={isExpanded ? "is-open" : ""} /> 일감 목록
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${isChangelogOpen ? "btn-primary" : ""}`}
                      aria-expanded={isChangelogOpen}
                      onClick={() => toggleChangelog(r.version)}
                    >
                      <DocIcon size={11} /> 체인지로그
                    </button>
                  </div>
                </div>

                <div className="cycle-metrics">
                  <div className="cycle-progress">
                    <div className="cycle-progress-bar">
                      <span style={{ width: `${r.progress_pct}%`, background: r.status === "released" ? "var(--done)" : undefined }} />
                    </div>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {r.progress_pct}%
                    </span>
                  </div>
                  <div className="cycle-stats muted">
                    <span>
                      완료 <strong>{r.done_tasks}</strong> / {r.total_tasks}건
                    </span>
                    <span>
                      진행·리뷰 <strong>{r.in_progress_tasks}</strong>건
                    </span>
                    <span>
                      대기 <strong>{r.todo_tasks}</strong>건
                    </span>
                    {r.total_points > 0 && (
                      <span>
                        포인트 <strong>{r.done_points}</strong> / {r.total_points}pt
                      </span>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <ul className="release-tasks-list">
                    {r.tasks.map((t) => {
                      const prio = PRIORITY_META[t.priority];
                      return (
                        <li key={t.id} className={`release-task-row ${STAGE_TONE[t.stage]}`}>
                          <span className="dot" />
                          <Link to={`/projects/${project.id}/tasks/${t.id}`} className="key-badge">
                            {t.key}
                          </Link>
                          <Link to={`/projects/${project.id}/tasks/${t.id}`} className="release-task-title">
                            {t.title}
                          </Link>
                          {prio && <span className={`pill ${prio.tone}`}>{prio.label}</span>}
                          <span className={`pill ${STAGE_TONE[t.stage]}`}>{STAGE_LABEL[t.stage]}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {isChangelogOpen && (
                  <div className="release-changelog-box">
                    <div className="release-changelog-head">
                      <label className="kind-toggle">
                        <input
                          type="checkbox"
                          checked={includeUnfinished}
                          onChange={(e) => toggleUnfinished(e.target.checked)}
                        />
                        미완료 일감 포함
                      </label>
                      <span className="spacer" />
                      <button type="button" className="btn btn-sm" onClick={copyMarkdown} disabled={!changelog || changelogBusy}>
                        {copied ? "복사됨 ✓" : "Markdown 복사"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={downloadMarkdown} disabled={!changelog || changelogBusy}>
                        .md 다운로드
                      </button>
                      {canCreate && (
                        <button type="button" className="btn btn-sm btn-accent" onClick={saveToWiki} disabled={!changelog || changelogBusy || savingWiki}>
                          {savingWiki ? "저장 중…" : "위키에 저장"}
                        </button>
                      )}
                    </div>
                    {savedWikiId && (
                      <div className="wiki-toast" style={{ marginBottom: 8 }}>
                        <span>릴리즈 노트를 위키 문서로 저장했습니다.</span>
                        <Link to={`/projects/${project.id}/wiki/${savedWikiId}`} className="btn btn-sm btn-primary">
                          위키 열기 →
                        </Link>
                      </div>
                    )}
                    {changelogBusy ? (
                      <p className="muted" style={{ fontSize: 12 }}>
                        체인지로그 생성 중…
                      </p>
                    ) : (
                      changelog && <pre className="release-md-pre">{changelog.markdown}</pre>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
