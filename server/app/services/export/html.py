"""Markdown → 단독 HTML (스타일 내장, 오프라인으로 열림). print=True 면 열자마자 인쇄 대화상자 → PDF 저장."""

from html import escape

from markdown_it import MarkdownIt
from mdit_py_plugins.tasklists import tasklists_plugin

from app.db import Database
from app.models.project import Project
from app.services.export.prepare import PageBlock, resolve_links, shift_headings

# 원시 HTML 은 이스케이프(XSS 방지), javascript: 링크는 markdown-it 기본 검증으로 차단
_md = MarkdownIt("commonmark", {"html": False, "typographer": False}).enable(["table", "strikethrough"]).use(tasklists_plugin)

CSS = """
:root { color-scheme: light; }
body { margin: 0; background: #eceef3; color: #0e1320; font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; word-break: keep-all; overflow-wrap: break-word; }
main { max-width: 860px; margin: 32px auto; padding: 44px 56px; background: #fff; border: 1px solid #dee2ea; border-radius: 12px; }
header.doc { margin-bottom: 28px; padding-bottom: 14px; border-bottom: 1px solid #dee2ea; }
header.doc .project { font-size: 12px; font-weight: 700; color: #2459e6; letter-spacing: .02em; }
section.page + section.page { margin-top: 48px; padding-top: 28px; border-top: 2px solid #eceef3; }
.page-title { margin: 0 0 6px; font-size: 2em; line-height: 1.25; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 22px; padding: 0; list-style: none; font-size: 12.5px; color: #5c6577; }
.meta b { color: #4a5366; font-weight: 600; margin-right: 4px; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 .6em; }
h2 { padding-bottom: .25em; border-bottom: 1px solid #dee2ea; }
a { color: #2459e6; }
code { font: .86em ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #f5f7fb; border: 1px solid #dee2ea; padding: .1em .35em; border-radius: 5px; }
pre { background: #0e1320; color: #d8deea; border-radius: 10px; padding: 12px 16px; overflow-x: auto; }
pre code { background: none; border: none; padding: 0; color: inherit; }
blockquote { margin: 0 0 1em; padding: 6px 14px; color: #4a5366; background: #f5f7fb; border-left: 3px solid #b9c0cc; }
table { border-collapse: collapse; margin: 0 0 1em; }
th, td { border: 1px solid #dee2ea; padding: 6px 12px; text-align: left; }
th { background: #f5f7fb; }
li.task-list-item { list-style: none; }
li.task-list-item input { margin: 0 .45em 0 -1.35em; }
img { max-width: 100%; }
footer { margin-top: 40px; font-size: 11px; color: #8e97aa; text-align: right; }
@media print {
  body { background: #fff; font-size: 11pt; }
  main { margin: 0; padding: 0; border: none; border-radius: 0; max-width: none; }
  section.page + section.page { break-before: page; border-top: none; margin-top: 0; padding-top: 0; }
  pre, table, blockquote { break-inside: avoid; }
  pre { background: #f5f7fb; color: #0e1320; border: 1px solid #dee2ea; }
  a { color: inherit; text-decoration: none; }
}
@page { size: A4; margin: 18mm 16mm; }
"""


def render_html(db: Database, project: Project, blocks: list[PageBlock], *, print_on_load: bool = False) -> str:
    bundle_ids = {b.page.id for b in blocks}
    sections = []
    for b in blocks:
        body_md = shift_headings(resolve_links(b.page.content, db, project, bundle_ids), b.depth + 1)
        tag = f"h{min(b.depth + 1, 6)}"
        meta = "".join(f"<li><b>{escape(k)}</b>{escape(v)}</li>" for k, v in b.meta)
        sections.append(
            f'<section class="page" id="{b.anchor}"><{tag} class="page-title">{escape(b.page.title)}</{tag}>'
            f'<ul class="meta">{meta}</ul>{_md.render(body_md)}</section>'
        )
    title = escape(blocks[0].page.title)
    script = "<script>addEventListener('load',()=>setTimeout(()=>print(),300))</script>" if print_on_load else ""
    return (
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{title}</title><style>{CSS}</style>{script}</head><body><main>"
        f'<header class="doc"><div class="project">{escape(project.key)} · {escape(project.name)}</div></header>'
        f"{''.join(sections)}<footer>MightyWork에서 내보냄</footer></main></body></html>"
    )
