import { cloneElement, isValidElement, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { requestFile } from "../api/http";
import { parseCalloutHeader, slugifyHeading, type HeadingItem } from "../lib/markdownHelpers";
import { hasTaskKey } from "../lib/wikiToTask";
import { MISSING_PREFIX, remarkWikiLinks, type LinkResolver } from "../lib/wikilinks";

const ATTACHMENT_RE = /^\/api(\/projects\/[^/]+\/attachments\/[^/]+)$/;

/** 인증이 필요한 프로젝트 첨부 이미지는 Bearer 토큰으로 받아 Blob URL 로 표시 */
function AuthImage({ src = "", alt = "", title }: { src?: string; alt?: string; title?: string }) {
  const match = ATTACHMENT_RE.exec(src);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!match) return;
    let active = true;
    let created: string | null = null;
    requestFile(match[1])
      .then(({ blob }) => {
        if (!active) return;
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
      })
      .catch(() => {
        if (active) setBlobUrl(null);
      });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [match?.[1]]);

  if (match) {
    return blobUrl ? <img src={blobUrl} alt={alt} title={title} loading="lazy" /> : <span className="muted">[{alt || "이미지 불러오는 중…"}]</span>;
  }
  return <img src={src} alt={alt} title={title} loading="lazy" />;
}

function extractNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractNodeText(node.props.children);
  return "";
}

/** 콜아웃 blockquote(첫 줄이 [!NOTE] 등) 변환 */
function renderBlockquote(children: ReactNode) {
  const list = Array.isArray(children) ? children : [children];
  const firstIdx = list.findIndex((c) => isValidElement(c));
  if (firstIdx >= 0) {
    const firstEl = list[firstIdx];
    if (isValidElement<{ children?: ReactNode }>(firstEl) && firstEl.type === "p") {
      const pKids = Array.isArray(firstEl.props.children) ? firstEl.props.children : [firstEl.props.children];
      const firstStr = pKids[0];
      if (typeof firstStr === "string") {
        const parsed = parseCalloutHeader(firstStr);
        if (parsed) {
          const restFirstP = [parsed.rest, ...pKids.slice(1)].filter((x) => x !== "" && x !== undefined && x !== null);
          const updatedFirstP = restFirstP.length > 0 ? cloneElement(firstEl, { key: "callout-p0" }, restFirstP) : null;
          const tail = list.slice(firstIdx + 1);
          const title = parsed.customTitle || parsed.meta.label;
          return (
            <div className={`callout callout-${parsed.meta.kind} ${parsed.meta.tone}`}>
              <div className="callout-title">{title}</div>
              {(updatedFirstP || tail.length > 0) && (
                <div className="callout-body">
                  {updatedFirstP}
                  {tail}
                </div>
              )}
            </div>
          );
        }
      }
    }
  }
  return <blockquote>{children}</blockquote>;
}

function makeComponents(
  resolver: LinkResolver | undefined,
  onConvertChecklistItem: ((text: string) => void) | undefined,
  projectKey: string | undefined,
  seenHeadings: Map<string, number>,
): Components {
  const headingId = (children: ReactNode) => slugifyHeading(extractNodeText(children).trim(), seenHeadings);

  return {
    h1: ({ children }) => <h1 id={headingId(children)}>{children}</h1>,
    h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
    blockquote: ({ children }) => renderBlockquote(children),
    img: ({ src, alt, title }) => <AuthImage src={src} alt={alt} title={title} />,
    li: ({ className, children, ...rest }) => {
      const isTaskItem = typeof className === "string" && className.includes("task-list-item");
      const text = isTaskItem && onConvertChecklistItem ? extractNodeText(children).replace(/\s+/g, " ").trim() : "";
      const showConvert = Boolean(isTaskItem && onConvertChecklistItem && text && !(projectKey && hasTaskKey(text, projectKey)));
      return (
        <li className={className} {...rest}>
          {children}
          {showConvert && (
            <button
              type="button"
              className="wiki-to-task-btn"
              title="이 체크리스트 항목으로 일감 생성"
              onClick={() => onConvertChecklistItem!(text)}
            >
              + 일감
            </button>
          )}
        </li>
      );
    },
    a: ({ href = "", title, className, children }) => {
      // [[없는 페이지]] — 생성 권한이 있으면 클릭해서 바로 만들기
      if (href.startsWith(MISSING_PREFIX)) {
        const pageTitle = decodeURIComponent(href.slice(MISSING_PREFIX.length));
        return resolver?.onMissing ? (
          <button type="button" className={className} title={`'${pageTitle}' 페이지 만들기`} onClick={() => resolver.onMissing!(pageTitle)}>
            {children}
          </button>
        ) : (
          <span className={className} title={title ?? undefined}>
            {children}
          </span>
        );
      }
      // 앱 내부 링크는 새로고침 없이 이동
      if (href.startsWith("/")) {
        return (
          <Link to={href} title={title ?? undefined} className={className}>
            {children}
          </Link>
        );
      }
      const external = /^https?:\/\//i.test(href);
      return (
        <a href={href} title={title ?? undefined} className={className} {...(external && { target: "_blank", rel: "noopener noreferrer" })}>
          {children}
        </a>
      );
    },
  };
}

/** 위키 긴 문서용 접이식 자동 목차(TOC) */
export function TableOfContents({ headings }: { headings: HeadingItem[] }) {
  const [open, setOpen] = useState(true);
  if (headings.length < 2) return null;

  return (
    <nav className="wiki-toc" aria-label="문서 목차">
      <button type="button" className="wiki-toc-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>목차 ({headings.length})</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {open ? "접기" : "펼치기"}
        </span>
      </button>
      {open && (
        <ol className="wiki-toc-list">
          {headings.map((h) => (
            <li key={h.id} className={`toc-l${h.level}`}>
              <a
                href={`#${h.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}

/**
 * GitHub 스타일 마크다운 렌더러 (표, 체크리스트, 콜아웃, 헤딩 앵커, 코드 하이라이트).
 * links 를 넘기면 [[페이지]] 위키 링크와 일감 키(KEY-12)를 링크로 바꾼다.
 * 원시 HTML 은 렌더링하지 않는다(XSS 방지) — react-markdown 기본 동작.
 */
export function Markdown({
  children,
  className = "",
  links,
  onConvertChecklistItem,
  projectKey,
}: {
  children: string;
  className?: string;
  links?: LinkResolver;
  onConvertChecklistItem?: (text: string) => void;
  projectKey?: string;
}) {
  const remarkPlugins = useMemo(() => (links ? [remarkGfm, remarkWikiLinks(links)] : [remarkGfm]), [links]);
  // 매 렌더 패스마다 헤딩 ID 중복 카운터를 초기화해 extractHeadings 와 1:1 일치시킨다
  const seenHeadings = new Map<string, number>();
  const components = makeComponents(links, onConvertChecklistItem, projectKey, seenHeadings);
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={[rehypeHighlight]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
