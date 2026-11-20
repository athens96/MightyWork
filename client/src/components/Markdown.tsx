import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { requestFile } from "../api/http";
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

function makeComponents(resolver?: LinkResolver): Components {
  return {
    img: ({ src, alt, title }) => <AuthImage src={src} alt={alt} title={title} />,
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

/**
 * GitHub 스타일 마크다운 렌더러 (표, 체크리스트, 취소선, 자동 링크, 코드 하이라이트).
 * links 를 넘기면 [[페이지]] 위키 링크와 일감 키(KEY-12)를 링크로 바꾼다.
 * 원시 HTML 은 렌더링하지 않는다(XSS 방지) — react-markdown 기본 동작.
 */
export function Markdown({ children, className = "", links }: { children: string; className?: string; links?: LinkResolver }) {
  const remarkPlugins = useMemo(() => (links ? [remarkGfm, remarkWikiLinks(links)] : [remarkGfm]), [links]);
  const components = useMemo(() => makeComponents(links), [links]);
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={[rehypeHighlight]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
