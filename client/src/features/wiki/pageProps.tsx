import { useState } from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../../components/Avatar";
import type { PageStatus, PageType, User, WikiPage, WikiPageSummary } from "../../types";

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  guide: "가이드",
  spec: "명세",
  decision: "결정",
  meeting: "회의록",
  reference: "참고",
  note: "메모",
};

export const PAGE_STATUS_LABEL: Record<PageStatus, string> = {
  draft: "초안",
  review: "검토 중",
  published: "확정",
  deprecated: "폐기",
};

export const PAGE_STATUS_TONE: Record<PageStatus, string> = {
  draft: "tone-stop",
  review: "tone-wait",
  published: "tone-done",
  deprecated: "tone-err",
};

export type PropsDraft = Pick<WikiPage, "page_type" | "status" | "owner_id" | "tags" | "parent_id">;

/** 보기 모드: 제목 아래 속성 줄 */
export function PropertiesBar({ page, users, basePath }: { page: WikiPage; users: User[]; basePath: string }) {
  const owner = users.find((u) => u.id === page.owner_id);
  if (!page.page_type && !page.status && !page.owner_id && page.tags.length === 0) return null;
  return (
    <div className="props-bar">
      {page.page_type && <span className="type-badge">{PAGE_TYPE_LABEL[page.page_type]}</span>}
      {page.status && <span className={`pill ${PAGE_STATUS_TONE[page.status]}`}>{PAGE_STATUS_LABEL[page.status]}</span>}
      {page.owner_id && (
        <span className="props-owner">
          <Avatar user={owner} size={16} /> {owner?.name || owner?.email || "알 수 없음"}
        </span>
      )}
      {page.tags.map((t) => (
        <Link key={t} to={`${basePath}?tag=${encodeURIComponent(t)}`} className="tag tag-link" title={`'${t}' 태그 문서 보기`}>
          #{t}
        </Link>
      ))}
    </div>
  );
}

/** 편집 모드: 속성 입력 줄 (상위 페이지 이동 포함) */
export function PropertiesEditor({
  value,
  onChange,
  members,
  parentCandidates = [],
}: {
  value: PropsDraft;
  onChange: (v: PropsDraft) => void;
  members: User[];
  parentCandidates?: WikiPageSummary[];
}) {
  const [tagDraft, setTagDraft] = useState("");
  const addTag = () => {
    const t = tagDraft.trim().replace(/^#/, "");
    if (t && !value.tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange({ ...value, tags: [...value.tags, t] });
    setTagDraft("");
  };
  return (
    <div className="props-editor">
      <label>
        <span>상위 문서</span>
        <select value={value.parent_id ?? ""} onChange={(e) => onChange({ ...value, parent_id: e.target.value || null })}>
          <option value="">최상위 (루트)</option>
          {parentCandidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>타입</span>
        <select value={value.page_type ?? ""} onChange={(e) => onChange({ ...value, page_type: (e.target.value || null) as PageType | null })}>
          <option value="">미지정</option>
          {(Object.keys(PAGE_TYPE_LABEL) as PageType[]).map((t) => (
            <option key={t} value={t}>
              {PAGE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>상태</span>
        <select value={value.status ?? ""} onChange={(e) => onChange({ ...value, status: (e.target.value || null) as PageStatus | null })}>
          <option value="">미지정</option>
          {(Object.keys(PAGE_STATUS_LABEL) as PageStatus[]).map((s) => (
            <option key={s} value={s}>
              {PAGE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>담당자</span>
        <select value={value.owner_id ?? ""} onChange={(e) => onChange({ ...value, owner_id: e.target.value || null })}>
          <option value="">미지정</option>
          {members.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </select>
      </label>
      <div className="props-tags">
        <span>태그</span>
        {value.tags.map((t) => (
          <span key={t} className="tag removable">
            #{t}
            <button onClick={() => onChange({ ...value, tags: value.tags.filter((x) => x !== t) })} aria-label={`${t} 제거`}>
              ×
            </button>
          </span>
        ))}
        <input
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          placeholder="태그 입력 후 Enter"
        />
      </div>
    </div>
  );
}
