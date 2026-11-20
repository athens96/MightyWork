import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { knowledgeApi, wikiApi } from "../../api";
import { ApiError } from "../../api/http";
import { GraphIcon, PlusIcon, SparklesIcon, TrashIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { can } from "../../lib/permissions";
import type {
  EntityKind,
  GlossaryTerm,
  GlossaryUsage,
  KnowledgeEntity,
  KnowledgeRelation,
  ProjectGraph,
  QAResponse,
  RelationKind,
  ReviewStatus,
  WikiPageSummary,
} from "../../types";
import { useCurrentProject } from "../projects/ProjectLayout";
import { ProjectGraphView } from "./ProjectGraphView";

type Tab = "glossary" | "review" | "graph" | "qa";

const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  system: "시스템",
  service: "서비스",
  api: "API",
  data: "데이터",
  role: "역할",
  decision: "결정",
  concept: "개념",
};

const RELATION_KIND_LABEL: Record<RelationKind, string> = {
  uses: "사용",
  depends_on: "의존",
  produces: "생성",
  owns: "담당",
  implements: "구현",
  decides: "결정",
  relates_to: "관련",
};

const STATUS_LABEL: Record<ReviewStatus, string> = { pending: "대기", approved: "승인", rejected: "거절" };
const STATUS_TONE: Record<ReviewStatus, string> = { pending: "tone-wait", approved: "tone-done", rejected: "tone-stop" };

/** 프로젝트 지식 베이스: 용어집 · 엔티티/관계 추출 리뷰 큐 · 전체 그래프 · 그래프 Q&A */
export function KnowledgePage() {
  const project = useCurrentProject();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "glossary";
  const setTab = (next: Tab) => setParams({ tab: next }, { replace: true });

  const canCreate = can(project, "create");
  const canEdit = can(project, "edit");
  const canDelete = can(project, "delete");

  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [entities, setEntities] = useState<KnowledgeEntity[]>([]);
  const [relations, setRelations] = useState<KnowledgeRelation[]>([]);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);

  // 용어집 폼/사용처
  const [termForm, setTermForm] = useState({ term: "", definition: "", synonyms: "", broader_id: "", wiki_page_id: "" });
  const [usagesFor, setUsagesFor] = useState<{ id: string; items: GlossaryUsage[] } | null>(null);

  // 리뷰 큐
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | "all">("all");
  const [extracting, setExtracting] = useState(false);
  const [extractMsg, setExtractMsg] = useState<string | null>(null);
  const [newEnt, setNewEnt] = useState<{ name: string; kind: EntityKind; description: string }>({ name: "", kind: "service", description: "" });
  const [newRel, setNewRel] = useState<{ source_entity_id: string; target_entity_id: string; kind: RelationKind; evidence: string }>({
    source_entity_id: "",
    target_entity_id: "",
    kind: "depends_on",
    evidence: "",
  });

  // 그래프 Q&A
  const [question, setQuestion] = useState("");
  const [qaBusy, setQaBusy] = useState(false);
  const [qaRes, setQaRes] = useState<QAResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAll = useCallback(() => {
    wikiApi.list(project.id).then(setPages, () => {});
    knowledgeApi.listGlossary(project.id).then(setTerms, () => {});
    knowledgeApi.listEntities(project.id).then(setEntities, () => {});
    knowledgeApi.listRelations(project.id).then(setRelations, () => {});
    knowledgeApi.fullGraph(project.id).then(setGraph, () => {});
  }, [project.id]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const addTerm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await knowledgeApi.createGlossary(project.id, {
        term: termForm.term.trim(),
        definition: termForm.definition.trim(),
        synonyms: termForm.synonyms.split(",").map((s) => s.trim()).filter(Boolean),
        broader_id: termForm.broader_id || null,
        wiki_page_id: termForm.wiki_page_id || null,
      });
      setTerms((prev) => [...prev, created].sort((a, b) => a.term.localeCompare(b.term)));
      setTermForm({ term: "", definition: "", synonyms: "", broader_id: "", wiki_page_id: "" });
      knowledgeApi.fullGraph(project.id).then(setGraph, () => {});
    } catch (err) {
      setError(err instanceof ApiError ? String(err.detail) : "용어 추가에 실패했습니다.");
    }
  };

  const removeTerm = async (t: GlossaryTerm) => {
    if (!confirm(`용어 '${t.term}' 을 삭제할까요?`)) return;
    await knowledgeApi.deleteGlossary(project.id, t.id);
    setTerms((prev) => prev.filter((x) => x.id !== t.id));
    if (usagesFor?.id === t.id) setUsagesFor(null);
  };

  const loadUsages = async (id: string) => {
    if (usagesFor?.id === id) return setUsagesFor(null);
    const items = await knowledgeApi.glossaryUsages(project.id, id);
    setUsagesFor({ id, items });
  };

  const runExtract = async () => {
    setExtracting(true);
    setExtractMsg(null);
    try {
      const res = await knowledgeApi.extract(project.id);
      setExtractMsg(`엔티티 +${res.entities_added}건, 관계 +${res.relations_added}건 추출됨 (대기 중: 엔티티 ${res.pending_entities}, 관계 ${res.pending_relations})`);
      reloadAll();
    } finally {
      setExtracting(false);
    }
  };

  const reviewEntity = async (id: string, status: ReviewStatus) => {
    const updated = await knowledgeApi.updateEntity(project.id, id, { status });
    setEntities((prev) => prev.map((e) => (e.id === id ? updated : e)));
    knowledgeApi.fullGraph(project.id).then(setGraph, () => {});
  };

  const reviewRelation = async (id: string, status: ReviewStatus) => {
    const updated = await knowledgeApi.updateRelation(project.id, id, { status });
    setRelations((prev) => prev.map((r) => (r.id === id ? updated : r)));
    knowledgeApi.fullGraph(project.id).then(setGraph, () => {});
  };

  const addManualEntity = async (e: FormEvent) => {
    e.preventDefault();
    if (!newEnt.name.trim()) return;
    setError(null);
    try {
      const created = await knowledgeApi.createEntity(project.id, { ...newEnt, name: newEnt.name.trim(), status: "approved" });
      setEntities((prev) => [created, ...prev]);
      setNewEnt({ name: "", kind: "service", description: "" });
      knowledgeApi.fullGraph(project.id).then(setGraph, () => {});
    } catch (err) {
      setError(err instanceof ApiError ? String(err.detail) : "엔티티 추가 실패");
    }
  };

  const addManualRelation = async (e: FormEvent) => {
    e.preventDefault();
    if (!newRel.source_entity_id || !newRel.target_entity_id) return;
    setError(null);
    try {
      const created = await knowledgeApi.createRelation(project.id, { ...newRel, status: "approved" });
      setRelations((prev) => [created, ...prev]);
      setNewRel({ source_entity_id: "", target_entity_id: "", kind: "depends_on", evidence: "" });
      knowledgeApi.fullGraph(project.id).then(setGraph, () => {});
    } catch (err) {
      setError(err instanceof ApiError ? String(err.detail) : "관계 추가 실패");
    }
  };

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim() || qaBusy) return;
    setQaBusy(true);
    try {
      setQaRes(await knowledgeApi.qa(project.id, question.trim()));
    } finally {
      setQaBusy(false);
    }
  };

  const pendingCount = entities.filter((e) => e.status === "pending").length + relations.filter((r) => r.status === "pending").length;
  const termById = new Map(terms.map((t) => [t.id, t]));
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const shownEntities = reviewFilter === "all" ? entities : entities.filter((e) => e.status === reviewFilter);
  const shownRelations = reviewFilter === "all" ? relations : relations.filter((r) => r.status === reviewFilter);

  return (
    <div className="knowledge-hub">
      <div className="kb-bar">
        <div className="segment">
          <button aria-pressed={tab === "glossary"} onClick={() => setTab("glossary")}>
            용어집 ({terms.length})
          </button>
          <button aria-pressed={tab === "review"} onClick={() => setTab("review")}>
            추출 · 리뷰 큐 {pendingCount > 0 && <span className="pill tone-wait">{pendingCount}</span>}
          </button>
          <button aria-pressed={tab === "graph"} onClick={() => setTab("graph")}>
            <GraphIcon size={12} /> 전체 그래프
          </button>
          <button aria-pressed={tab === "qa"} onClick={() => setTab("qa")}>
            <SparklesIcon size={12} /> 그래프 Q&A
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {/* 1) 프로젝트 용어집 */}
      {tab === "glossary" && (
        <div className="kb-section">
          {canCreate && (
            <form className="card kb-form" onSubmit={addTerm}>
              <input value={termForm.term} onChange={(e) => setTermForm({ ...termForm, term: e.target.value })} placeholder="표제어 (예: 싱글사인온)" required />
              <input value={termForm.synonyms} onChange={(e) => setTermForm({ ...termForm, synonyms: e.target.value })} placeholder="동의어 (쉼표 구분, 예: SSO, 통합 로그인)" />
              <input value={termForm.definition} onChange={(e) => setTermForm({ ...termForm, definition: e.target.value })} placeholder="정의" />
              <select value={termForm.broader_id} onChange={(e) => setTermForm({ ...termForm, broader_id: e.target.value })}>
                <option value="">상위 용어 없음</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    상위: {t.term}
                  </option>
                ))}
              </select>
              <select value={termForm.wiki_page_id} onChange={(e) => setTermForm({ ...termForm, wiki_page_id: e.target.value })}>
                <option value="">연결 위키 없음</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    위키: {p.title}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-primary">
                <PlusIcon size={11} /> 용어 추가
              </button>
            </form>
          )}
          {terms.length === 0 ? (
            <div className="card empty">아직 등록된 용어가 없습니다. 프로젝트 도메인 용어와 동의어·상하위 관계를 정리해 보세요.</div>
          ) : (
            <div className="card rows">
              {terms.map((t) => {
                const broader = t.broader_id ? termById.get(t.broader_id) : undefined;
                const narrower = terms.filter((c) => c.broader_id === t.id);
                return (
                  <div key={t.id} className="glossary-row">
                    <div className="row">
                      <span className="row-main">
                        <span className="row-title">
                          {t.term}
                          {t.synonyms.map((s) => (
                            <span key={s} className="tag">
                              {s}
                            </span>
                          ))}
                          {broader && <span className="pill tone-stop">↑ {broader.term}</span>}
                          {narrower.length > 0 && <span className="muted">하위 {narrower.map((n) => n.term).join(", ")}</span>}
                        </span>
                        <span className="row-meta">{t.definition || "정의 없음"}</span>
                      </span>
                      <div className="row-actions">
                        {t.wiki_page_id && (
                          <Link to={`/projects/${project.id}/wiki/${t.wiki_page_id}`} className="btn btn-sm btn-ghost">
                            위키
                          </Link>
                        )}
                        <button type="button" className="btn btn-sm" onClick={() => loadUsages(t.id)}>
                          {usagesFor?.id === t.id ? "사용처 닫기" : "사용처"}
                        </button>
                        {canDelete && (
                          <button type="button" className="icon-btn danger" onClick={() => removeTerm(t)} title="삭제">
                            <TrashIcon size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    {usagesFor?.id === t.id && (
                      <div className="usage-box">
                        {usagesFor.items.length === 0 ? (
                          <span className="muted">위키나 일감에서 언급된 곳이 없습니다.</span>
                        ) : (
                          usagesFor.items.map((u) => (
                            <Link
                              key={u.source_type + u.source_id}
                              to={u.source_type === "wiki" ? `/projects/${project.id}/wiki/${u.source_id}` : `/projects/${project.id}/tasks/${u.source_id}`}
                              className="usage-item"
                            >
                              <strong>
                                {u.source_type === "task" ? `${project.key}-${u.number} ` : ""}
                                {u.title}
                              </strong>{" "}
                              <span className="muted">({u.count}회) {u.snippets[0]}</span>
                            </Link>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 2) 고정 스키마 엔티티/관계 추출 + 리뷰 큐 */}
      {tab === "review" && (
        <div className="kb-section">
          <div className="kb-actions-bar">
            {canEdit && (
              <button className="btn btn-primary" disabled={extracting} onClick={runExtract}>
                <SparklesIcon size={12} /> {extracting ? "추출 중…" : "위키·일감·용어집에서 자동 추출"}
              </button>
            )}
            <div className="segment">
              {(["all", "pending", "approved", "rejected"] as const).map((st) => (
                <button key={st} aria-pressed={reviewFilter === st} onClick={() => setReviewFilter(st)}>
                  {st === "all" ? "전체" : STATUS_LABEL[st]}
                </button>
              ))}
            </div>
            {extractMsg && <span className="muted">{extractMsg}</span>}
          </div>

          {canCreate && (
            <form className="card kb-form compact" onSubmit={addManualEntity}>
              <input value={newEnt.name} onChange={(e) => setNewEnt({ ...newEnt, name: e.target.value })} placeholder="엔티티 직접 추가 (예: OAuth 서버)" />
              <select value={newEnt.kind} onChange={(e) => setNewEnt({ ...newEnt, kind: e.target.value as EntityKind })}>
                {(Object.keys(ENTITY_KIND_LABEL) as EntityKind[]).map((k) => (
                  <option key={k} value={k}>
                    {ENTITY_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input value={newEnt.description} onChange={(e) => setNewEnt({ ...newEnt, description: e.target.value })} placeholder="설명" />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!newEnt.name.trim()}>
                엔티티 추가
              </button>
            </form>
          )}

          <h3 className="group-head">엔티티 ({shownEntities.length})</h3>
          {shownEntities.length === 0 ? (
            <div className="card empty">표시할 엔티티가 없습니다. 상단 '자동 추출'을 눌러 후보를 모아보세요.</div>
          ) : (
            <div className="card rows">
              {shownEntities.map((ent) => (
                <div key={ent.id} className="row">
                  <span className="key-badge">{ENTITY_KIND_LABEL[ent.kind]}</span>
                  <span className="row-main">
                    <span className="row-title">
                      {ent.name} <span className={`pill ${STATUS_TONE[ent.status]}`}>{STATUS_LABEL[ent.status]}</span>
                      <span className="muted">신뢰도 {Math.round(ent.confidence * 100)}%</span>
                    </span>
                    <span className="row-meta">{ent.description || ent.sources[0]?.excerpt || "설명 없음"}</span>
                  </span>
                  {canEdit && (
                    <div className="row-actions">
                      {ent.status !== "approved" && (
                        <button className="btn btn-sm btn-primary" onClick={() => reviewEntity(ent.id, "approved")}>
                          승인
                        </button>
                      )}
                      {ent.status !== "rejected" && (
                        <button className="btn btn-sm btn-ghost" onClick={() => reviewEntity(ent.id, "rejected")}>
                          거절
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <h3 className="group-head">관계 ({shownRelations.length})</h3>
          {canCreate && entities.length >= 2 && (
            <form className="card kb-form compact" onSubmit={addManualRelation}>
              <select value={newRel.source_entity_id} onChange={(e) => setNewRel({ ...newRel, source_entity_id: e.target.value })}>
                <option value="">출발 엔티티…</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <select value={newRel.kind} onChange={(e) => setNewRel({ ...newRel, kind: e.target.value as RelationKind })}>
                {(Object.keys(RELATION_KIND_LABEL) as RelationKind[]).map((k) => (
                  <option key={k} value={k}>
                    {RELATION_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <select value={newRel.target_entity_id} onChange={(e) => setNewRel({ ...newRel, target_entity_id: e.target.value })}>
                <option value="">대상 엔티티…</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <input value={newRel.evidence} onChange={(e) => setNewRel({ ...newRel, evidence: e.target.value })} placeholder="근거 문장 (선택)" />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!newRel.source_entity_id || !newRel.target_entity_id}>
                관계 추가
              </button>
            </form>
          )}
          {shownRelations.length === 0 ? (
            <div className="card empty">표시할 관계가 없습니다.</div>
          ) : (
            <div className="card rows">
              {shownRelations.map((r) => (
                <div key={r.id} className="row">
                  <span className="key-badge">{RELATION_KIND_LABEL[r.kind]}</span>
                  <span className="row-main">
                    <span className="row-title">
                      {entityById.get(r.source_entity_id)?.name ?? "?"} → {entityById.get(r.target_entity_id)?.name ?? "?"}{" "}
                      <span className={`pill ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    </span>
                    <span className="row-meta">{r.evidence || "근거 없음"}</span>
                  </span>
                  {canEdit && (
                    <div className="row-actions">
                      {r.status !== "approved" && (
                        <button className="btn btn-sm btn-primary" onClick={() => reviewRelation(r.id, "approved")}>
                          승인
                        </button>
                      )}
                      {r.status !== "rejected" && (
                        <button className="btn btn-sm btn-ghost" onClick={() => reviewRelation(r.id, "rejected")}>
                          거절
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 3) 전체 그래프 뷰 */}
      {tab === "graph" && graph && <ProjectGraphView nodes={graph.nodes} edges={graph.edges} projectId={project.id} />}

      {/* 4) 그래프 기반 Q&A */}
      {tab === "qa" && (
        <div className="kb-section">
          <form className="card create-card" onSubmit={ask}>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="프로젝트에 대해 질문하세요 (예: SSO 는 무엇에 의존하나요?)"
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn btn-primary" disabled={!question.trim() || qaBusy}>
              <SparklesIcon size={12} /> {qaBusy ? "탐색 중…" : "질문하기"}
            </button>
          </form>
          {qaRes && (
            <div className="qa-result">
              <div className="card qa-answer">
                {qaRes.expanded_terms.length > 0 && (
                  <div className="qa-terms">
                    <span className="muted">확장 검색어:</span>
                    {qaRes.expanded_terms.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <Markdown>{qaRes.answer}</Markdown>
              </div>
              {qaRes.citations.length > 0 && (
                <div className="card rows">
                  <div className="group-head" style={{ padding: "8px 12px 0" }}>
                    근거 출처 ({qaRes.citations.length})
                  </div>
                  {qaRes.citations.map((c) => (
                    <Link key={`${c.kind}-${c.id}`} to={c.link} className="row">
                      <span className="key-badge">{c.kind === "task" && c.number ? `${project.key}-${c.number}` : c.kind.toUpperCase()}</span>
                      <span className="row-main">
                        <span className="row-title">{c.title}</span>
                        <span className="row-meta">{c.snippet}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
              {qaRes.graph_nodes.length > 0 && (
                <ProjectGraphView nodes={qaRes.graph_nodes} edges={qaRes.graph_edges} projectId={project.id} compact />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
