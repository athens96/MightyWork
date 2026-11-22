use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use pulldown_cmark::{html, Event, Options, Parser};
use regex::Regex;
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::config::Settings;
use crate::db::Database;
use crate::models::{PageStatus, PageType, Project, User, WikiPage};
use crate::services::links::{project_pages, resolve_links};

fn fence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s{0,3}(```|~~~)").unwrap())
}

fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\s{0,3})(#{1,6})(\s)").unwrap())
}

fn unsafe_fname_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"[\\/:*?"<>|\n\r\t]+"#).unwrap())
}

fn task_item_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\s*[-*+]\s+)\[([ xX])\]\s+").unwrap())
}

fn front_matter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)\A---\n(.*?)\n---\n").unwrap())
}

fn h1_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^#\s+(.+?)\s*#*\s*$").unwrap())
}

fn local_img_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"!\[[^\]]*\]\(([^)]*)\)").unwrap())
}

fn type_label(t: PageType) -> &'static str {
    match t {
        PageType::Guide => "가이드",
        PageType::Spec => "명세",
        PageType::Decision => "결정",
        PageType::Meeting => "회의록",
        PageType::Reference => "참고",
        PageType::Note => "메모",
    }
}

fn status_label(s: PageStatus) -> &'static str {
    match s {
        PageStatus::Draft => "초안",
        PageStatus::Review => "검토 중",
        PageStatus::Published => "확정",
        PageStatus::Deprecated => "폐기",
    }
}

pub struct PageBlock {
    pub page: WikiPage,
    pub depth: usize,
    pub meta: Vec<(String, String)>,
}

impl PageBlock {
    pub fn anchor(&self) -> String {
        format!("page-{}", self.page.id)
    }
}

fn build_meta(p: &WikiPage, users: &HashMap<String, User>) -> Vec<(String, String)> {
    let mut meta = Vec::new();
    if !p.aliases.is_empty() {
        meta.push(("별칭".into(), p.aliases.join(", ")));
    }
    if let Some(pt) = p.page_type {
        meta.push(("타입".into(), type_label(pt).into()));
    }
    if let Some(st) = p.status {
        meta.push(("상태".into(), status_label(st).into()));
    }
    if let Some(oid) = &p.owner_id {
        if let Some(u) = users.get(oid) {
            let label = if u.name.is_empty() { &u.email } else { &u.name };
            meta.push(("담당자".into(), label.into()));
        }
    }
    if !p.tags.is_empty() {
        let tags = p.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ");
        meta.push(("태그".into(), tags));
    }
    meta.push(("수정".into(), p.updated_at.format("%Y-%m-%d").to_string()));
    meta
}

pub fn collect(db: &Database, project: &Project, root: &WikiPage, include_children: bool) -> Vec<PageBlock> {
    let mut pages = project_pages(db, &project.id).unwrap_or_default();
    pages.sort_by_key(|p| p.created_at);
    let users: HashMap<String, User> = db
        .users
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|u| (u.id.clone(), u))
        .collect();
    let mut children: HashMap<Option<String>, Vec<WikiPage>> = HashMap::new();
    for p in pages {
        children.entry(p.parent_id.clone()).or_default().push(p);
    }

    let mut out = Vec::new();
    fn walk(
        p: &WikiPage,
        depth: usize,
        include_children: bool,
        children: &HashMap<Option<String>, Vec<WikiPage>>,
        users: &HashMap<String, User>,
        out: &mut Vec<PageBlock>,
    ) {
        out.push(PageBlock {
            page: p.clone(),
            depth,
            meta: build_meta(p, users),
        });
        if include_children {
            if let Some(kids) = children.get(&Some(p.id.clone())) {
                for c in kids {
                    walk(c, depth + 1, true, children, users, out);
                }
            }
        }
    }
    walk(root, 0, include_children, &children, &users, &mut out);
    out
}

pub fn shift_headings(md: &str, by: usize) -> String {
    if by == 0 {
        return md.to_string();
    }
    let mut out = Vec::new();
    let mut in_code = false;
    for line in md.split('\n') {
        if fence_re().is_match(line) {
            in_code = !in_code;
            out.push(line.to_string());
        } else if !in_code {
            if let Some(caps) = heading_re().captures(line) {
                let m = caps.get(0).unwrap();
                let level = (caps[2].len() + by).min(6);
                out.push(format!(
                    "{}{}{}{}",
                    &caps[1],
                    "#".repeat(level),
                    &caps[3],
                    &line[m.end()..]
                ));
            } else {
                out.push(line.to_string());
            }
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

pub fn safe_filename(title: &str, ext: &str) -> String {
    let cleaned: String = unsafe_fname_re()
        .replace_all(title, " ")
        .trim()
        .chars()
        .take(80)
        .collect();
    let name = if cleaned.is_empty() { "wiki" } else { &cleaned };
    if ext.is_empty() {
        name.to_string()
    } else {
        format!("{name}.{ext}")
    }
}

pub fn front_matter(page: &WikiPage, db: &Database) -> String {
    let owner = page
        .owner_id
        .as_deref()
        .and_then(|id| db.users.get(id).ok().flatten());
    let mut lines = vec![format!("title: {}", json!(page.title))];
    if !page.aliases.is_empty() {
        lines.push(format!("aliases: {}", json!(page.aliases)));
    }
    if !page.tags.is_empty() {
        lines.push(format!("tags: {}", json!(page.tags)));
    }
    if let Some(pt) = page.page_type {
        lines.push(format!("type: {}", json!(pt.as_str())));
    }
    if let Some(st) = page.status {
        lines.push(format!("status: {}", json!(st.as_str())));
    }
    if let Some(u) = owner {
        lines.push(format!("owner: {}", json!(u.email)));
    }
    lines.push(format!(
        "updated: {}",
        json!(page.updated_at.format("%Y-%m-%dT%H:%M:%S+00:00").to_string())
    ));
    format!("---\n{}\n---\n", lines.join("\n"))
}

pub fn render_markdown(db: &Database, blocks: &[PageBlock]) -> String {
    if blocks.len() == 1 {
        let p = &blocks[0].page;
        return format!("{}\n# {}\n\n{}\n", front_matter(p, db), p.title, p.content);
    }
    let mut out = front_matter(&blocks[0].page, db);
    for b in blocks {
        let hashes = "#".repeat((b.depth + 1).min(6));
        out.push_str(&format!(
            "\n{hashes} {}\n\n{}\n",
            b.page.title,
            shift_headings(&b.page.content, b.depth + 1)
        ));
    }
    out
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_safe_markdown_html(md: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    // Escape raw HTML nodes to prevent XSS (mirrors markdown-it html=False)
    let parser = Parser::new_ext(md, opts).map(|ev| match ev {
        Event::Html(raw) | Event::InlineHtml(raw) => Event::Text(raw),
        other => other,
    });
    let mut html_out = String::new();
    html::push_html(&mut html_out, parser);
    html_out
}

const EXPORT_CSS: &str = r#"
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
"#;

pub fn render_html(db: &Database, project: &Project, blocks: &[PageBlock], print_on_load: bool) -> String {
    let bundle_ids: HashSet<String> = blocks.iter().map(|b| b.page.id.clone()).collect();
    let mut sections = String::new();
    for b in blocks {
        let resolved = resolve_links(&b.page.content, db, project, Some(&bundle_ids));
        let body_md = shift_headings(&resolved, b.depth + 1);
        let tag = format!("h{}", (b.depth + 1).min(6));
        let meta: String = b
            .meta
            .iter()
            .map(|(k, v)| format!("<li><b>{}</b>{}</li>", escape_html(k), escape_html(v)))
            .collect();
        sections.push_str(&format!(
            r#"<section class="page" id="{}"><{tag} class="page-title">{}</{tag}><ul class="meta">{meta}</ul>{}</section>"#,
            b.anchor(),
            escape_html(&b.page.title),
            render_safe_markdown_html(&body_md),
        ));
    }
    let title = escape_html(&blocks[0].page.title);
    let script = if print_on_load {
        "<script>addEventListener('load',()=>setTimeout(()=>print(),300))</script>"
    } else {
        ""
    };
    format!(
        r#"<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{EXPORT_CSS}</style>{script}</head><body><main><header class="doc"><div class="project">{} · {}</div></header>{sections}<footer>MightyWork에서 내보냄</footer></main></body></html>"#,
        escape_html(&project.key),
        escape_html(&project.name),
    )
}

pub fn build_zip(db: &Database, project: &Project) -> Result<Vec<u8>, String> {
    let mut pages = project_pages(db, &project.id).map_err(|e| format!("{e:?}"))?;
    pages.sort_by_key(|p| p.created_at);
    let by_id: HashMap<&str, &WikiPage> = pages.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut buf = Cursor::new(Vec::new());
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut z = ZipWriter::new(&mut buf);
    let mut used = HashSet::new();

    for p in &pages {
        let mut parts = Vec::new();
        let mut cur = p;
        let mut seen = HashSet::new();
        while let Some(pid) = cur.parent_id.as_deref() {
            if !seen.insert(pid) {
                break;
            }
            if let Some(parent) = by_id.get(pid) {
                parts.push(safe_filename(&parent.title, ""));
                cur = parent;
            } else {
                break;
            }
        }
        parts.reverse();
        let mut folder = vec!["wiki".to_string()];
        folder.extend(parts);
        let mut name = format!("{}/{}", folder.join("/"), safe_filename(&p.title, "md"));
        if used.contains(&name) {
            let short = &p.id[..p.id.len().min(6)];
            name = format!("{}-{short}.md", name.trim_end_matches(".md"));
        }
        used.insert(name.clone());
        let content = format!("{}\n# {}\n\n{}\n", front_matter(p, db), p.title, p.content);
        z.start_file(name, opts).map_err(|e| e.to_string())?;
        z.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    }

    let mut all_blocks = Vec::new();
    for r in pages
        .iter()
        .filter(|p| p.parent_id.as_deref().is_none_or(|pid| !by_id.contains_key(pid)))
    {
        all_blocks.extend(collect(db, project, r, true));
    }
    if !all_blocks.is_empty() {
        let html_str = render_html(db, project, &all_blocks, false);
        z.start_file("wiki.html", opts).map_err(|e| e.to_string())?;
        z.write_all(html_str.as_bytes()).map_err(|e| e.to_string())?;
    }
    z.finish().map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

// ---------------------------------------------------------------- DOCX (pandoc subprocess)

const TABLE_STYLE: &str = concat!(
    r#"<w:style w:type="table" w:customStyle="1" w:styleId="Table"><w:name w:val="Table"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>"#,
    r#"<w:top w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>"#,
    r#"<w:left w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>"#,
    r#"<w:bottom w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>"#,
    r#"<w:right w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>"#,
    r#"<w:insideH w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>"#,
    r#"<w:insideV w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>"#,
    r#"</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>"#,
    r#"<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F5F7FB"/></w:tcPr></w:tblStylePr></w:style>"#
);

fn find_pandoc(settings: &Settings) -> Option<PathBuf> {
    let candidate = PathBuf::from(&settings.pandoc_bin);
    if candidate.is_file() {
        return std::fs::canonicalize(&candidate).ok().or(Some(candidate));
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(&settings.pandoc_bin);
            if p.is_file() {
                return std::fs::canonicalize(&p).ok().or(Some(p));
            }
        }
    }
    // Fallback to pypandoc bundled pandoc inside server/.venv if present
    let venv_candidates = [
        PathBuf::from(".venv/lib"),
        PathBuf::from("../server/.venv/lib"),
    ];
    for base in venv_candidates {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let p = entry
                    .path()
                    .join("site-packages/pypandoc/files/pandoc");
                if p.is_file() {
                    return std::fs::canonicalize(&p).ok().or(Some(p));
                }
            }
        }
    }
    None
}

fn reference_docx_path(pandoc: &Path) -> Result<PathBuf, String> {
    static CACHE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let out = Command::new(pandoc)
                .args(["--print-default-data-file", "reference.docx"])
                .output()
                .map_err(|e| format!("pandoc 실행 실패: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).into_owned());
            }
            let dir = std::env::temp_dir().join(format!("mw-ref-{}", std::process::id()));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let dst = dir.join("reference-ko.docx");

            let mut zin = ZipArchive::new(Cursor::new(out.stdout)).map_err(|e| e.to_string())?;
            let out_file = std::fs::File::create(&dst).map_err(|e| e.to_string())?;
            let mut zout = ZipWriter::new(out_file);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            let table_re = Regex::new(r#"(?s)<w:style w:type="table"[^>]*w:styleId="Table".*?</w:style>"#).unwrap();

            for i in 0..zin.len() {
                let mut f = zin.by_index(i).map_err(|e| e.to_string())?;
                let name = f.name().to_string();
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                if name == "word/styles.xml" {
                    let xml = String::from_utf8_lossy(&bytes)
                        .replace(r#"w:eastAsia="zh-CN""#, r#"w:eastAsia="ko-KR""#);
                    let xml = table_re.replace(&xml, TABLE_STYLE).into_owned();
                    bytes = xml.into_bytes();
                }
                zout.start_file(name, opts).map_err(|e| e.to_string())?;
                zout.write_all(&bytes).map_err(|e| e.to_string())?;
            }
            zout.finish().map_err(|e| e.to_string())?;
            Ok(dst)
        })
        .clone()
}

pub enum ConvertError {
    Unavailable(String),
    Failed(String),
}

pub fn render_docx(
    settings: &Settings,
    db: &Database,
    project: &Project,
    blocks: &[PageBlock],
) -> Result<Vec<u8>, ConvertError> {
    let pandoc = find_pandoc(settings)
        .ok_or_else(|| ConvertError::Unavailable("pandoc 을 찾을 수 없습니다 (PANDOC_BIN)".into()))?;
    let ref_doc = reference_docx_path(&pandoc).map_err(ConvertError::Failed)?;

    let mut md = String::new();
    for b in blocks {
        let hashes = "#".repeat((b.depth + 1).min(6));
        let meta = b
            .meta
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(" · ");
        let body = shift_headings(&resolve_links(&b.page.content, db, project, None), b.depth + 1);
        md.push_str(&format!("{hashes} {}\n\n*{meta}*\n\n{body}\n\n", b.page.title));
    }

    let tmp_dir = std::env::temp_dir().join(format!("mw-docx-{}", crate::models::new_id()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| ConvertError::Failed(e.to_string()))?;
    let in_path = tmp_dir.join("in.md");
    let out_path = tmp_dir.join("out.docx");
    let res = (|| -> Result<Vec<u8>, ConvertError> {
        std::fs::write(&in_path, md.as_bytes()).map_err(|e| ConvertError::Failed(e.to_string()))?;
        let output = Command::new(&pandoc)
            .args([
                "-f",
                "gfm",
                "-t",
                "docx",
                "--sandbox",
                &format!("--reference-doc={}", ref_doc.display()),
                "-o",
                out_path.to_str().unwrap(),
                in_path.to_str().unwrap(),
            ])
            .current_dir(&tmp_dir)
            .output()
            .map_err(|e| ConvertError::Failed(e.to_string()))?;
        if !output.status.success() {
            return Err(ConvertError::Failed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        std::fs::read(&out_path).map_err(|e| ConvertError::Failed(e.to_string()))
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    res
}

// ---------------------------------------------------------------- Hangul / kordoc subprocess

fn find_kordoc_cmd(settings: &Settings) -> Result<(PathBuf, PathBuf), ConvertError> {
    let node = if Path::new(&settings.kordoc_node).is_file() {
        PathBuf::from(&settings.kordoc_node)
    } else {
        std::env::var("PATH")
            .ok()
            .and_then(|pv| {
                std::env::split_paths(&pv)
                    .map(|d| d.join(&settings.kordoc_node))
                    .find(|p| p.is_file())
            })
            .ok_or_else(|| ConvertError::Unavailable("Node.js 를 찾을 수 없습니다 (KORDOC_NODE)".into()))?
    };
    let cli = if settings.kordoc_cli.is_file() {
        std::fs::canonicalize(&settings.kordoc_cli).unwrap_or_else(|_| settings.kordoc_cli.clone())
    } else {
        let alt = PathBuf::from("../server").join(&settings.kordoc_cli);
        if alt.is_file() {
            std::fs::canonicalize(&alt).unwrap_or(alt)
        } else {
            return Err(ConvertError::Unavailable(
                "kordoc 이 설치되지 않았습니다 — server/tools/kordoc 에서 `npm ci` 를 실행하세요".into(),
            ));
        }
    };
    let node = std::fs::canonicalize(&node).unwrap_or(node);
    Ok((node, cli))
}

fn run_kordoc(settings: &Settings, args: &[&str], cwd: &Path) -> Result<(), ConvertError> {
    let (node, cli) = find_kordoc_cmd(settings)?;
    let out = Command::new(&node)
        .arg(&cli)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| ConvertError::Failed(e.to_string()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let raw = if !stderr.trim().is_empty() { stderr } else { stdout };
        let tail: Vec<&str> = raw.trim().lines().rev().take(3).collect();
        let msg = tail.into_iter().rev().collect::<Vec<_>>().join(" / ");
        return Err(ConvertError::Failed(if msg.is_empty() {
            format!("kordoc 종료 코드 {:?}", out.status.code())
        } else {
            msg
        }));
    }
    Ok(())
}

fn tasks_to_symbols(md: &str) -> String {
    let mut out = Vec::new();
    let mut in_code = false;
    for line in md.split('\n') {
        if fence_re().is_match(line) {
            in_code = !in_code;
            out.push(line.to_string());
        } else if !in_code {
            let replaced = task_item_re().replace(line, |caps: &regex::Captures| {
                let mark = if matches!(&caps[2], "x" | "X") { "☑ " } else { "☐ " };
                format!("{}{mark}", &caps[1])
            });
            out.push(replaced.into_owned());
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

pub fn render_hangul(
    settings: &Settings,
    db: &Database,
    project: &Project,
    blocks: &[PageBlock],
    fmt: &str,
    preset: Option<&str>,
) -> Result<Vec<u8>, ConvertError> {
    let chosen_preset = preset.unwrap_or_else(|| {
        if blocks.first().and_then(|b| b.page.page_type) == Some(PageType::Meeting) {
            "minutes"
        } else {
            "report"
        }
    });
    let mut md = String::new();
    for b in blocks {
        let hashes = "#".repeat((b.depth + 1).min(6));
        let meta = b
            .meta
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(" · ");
        let body = shift_headings(&resolve_links(&b.page.content, db, project, None), b.depth + 1);
        md.push_str(&format!(
            "{hashes} {}\n\n{meta}\n\n{}\n\n",
            b.page.title,
            tasks_to_symbols(&body)
        ));
    }

    let tmp_dir = std::env::temp_dir().join(format!("mw-hwp-{}", crate::models::new_id()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| ConvertError::Failed(e.to_string()))?;
    let src = tmp_dir.join("in.md");
    let out = tmp_dir.join(format!("out.{fmt}"));
    let res = (|| -> Result<Vec<u8>, ConvertError> {
        std::fs::write(&src, md.as_bytes()).map_err(|e| ConvertError::Failed(e.to_string()))?;
        run_kordoc(
            settings,
            &[
                "generate",
                src.to_str().unwrap(),
                "-o",
                out.to_str().unwrap(),
                "--preset",
                chosen_preset,
            ],
            &tmp_dir,
        )?;
        if !out.is_file() {
            return Err(ConvertError::Failed("변환 결과 파일이 만들어지지 않았습니다".into()));
        }
        std::fs::read(&out).map_err(|e| ConvertError::Failed(e.to_string()))
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    res
}

// ---------------------------------------------------------------- Import

pub const TEXT_EXT: &[&str] = &[".md", ".markdown", ".txt"];
pub const KORDOC_EXT: &[&str] = &[".hwp", ".hwpx", ".docx", ".pdf", ".pptx", ".xlsx"];
pub const IMPORT_MAX_BYTES: usize = 20 * 1024 * 1024;

pub struct ImportedPage {
    pub title: String,
    pub content: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub page_type: Option<PageType>,
    pub status: Option<PageStatus>,
}

pub enum ImportError {
    Unsupported(String),
    Unavailable(String),
    Failed(String),
}

fn parse_front_matter(md: &str) -> (HashMap<String, Value>, &str) {
    let Some(caps) = front_matter_re().captures(md) else {
        return (HashMap::new(), md);
    };
    let mut data = HashMap::new();
    for line in caps[1].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            let parsed = serde_json::from_str::<Value>(v)
                .unwrap_or_else(|_| Value::String(v.trim_matches('"').to_string()));
            data.insert(k.trim().to_string(), parsed);
        }
    }
    (data, &md[caps.get(0).unwrap().end()..])
}

pub fn import_to_page(settings: &Settings, filename: &str, data: &[u8]) -> Result<ImportedPage, ImportError> {
    let path = Path::new(filename);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_lowercase()))
        .unwrap_or_default();
    if !TEXT_EXT.contains(&ext.as_str()) && !KORDOC_EXT.contains(&ext.as_str()) {
        return Err(ImportError::Unsupported(format!(
            "지원하지 않는 형식입니다: {}",
            if ext.is_empty() { "(확장자 없음)" } else { &ext }
        )));
    }
    let stem_raw = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let stem: String = if stem_raw.is_empty() {
        "가져온 문서".into()
    } else {
        stem_raw.chars().take(200).collect()
    };

    let md = if TEXT_EXT.contains(&ext.as_str()) {
        let s = String::from_utf8_lossy(data);
        s.strip_prefix('\u{feff}')
            .unwrap_or(&s)
            .replace("\r\n", "\n")
    } else {
        let tmp_dir = std::env::temp_dir().join(format!("mw-import-{}", crate::models::new_id()));
        std::fs::create_dir_all(&tmp_dir).map_err(|e| ImportError::Failed(e.to_string()))?;
        let src = tmp_dir.join(format!("upload{ext}"));
        let out = tmp_dir.join("out.md");
        let res = (|| -> Result<String, ImportError> {
            std::fs::write(&src, data).map_err(|e| ImportError::Failed(e.to_string()))?;
            run_kordoc(
                settings,
                &[src.to_str().unwrap(), "-o", out.to_str().unwrap(), "--silent"],
                &tmp_dir,
            )
            .map_err(|e| match e {
                ConvertError::Unavailable(m) => ImportError::Unavailable(m),
                ConvertError::Failed(m) => ImportError::Failed(m),
            })?;
            if !out.is_file() {
                return Err(ImportError::Failed("변환 결과가 없습니다".into()));
            }
            std::fs::read_to_string(&out).map_err(|e| ImportError::Failed(e.to_string()))
        })();
        let _ = std::fs::remove_dir_all(&tmp_dir);
        res?
    };

    let (meta, rest) = parse_front_matter(&md);
    let fallback = meta
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| stem.clone());

    let (mut title, body_raw) = if let Some(caps) = h1_re().captures(rest) {
        let m = caps.get(0).unwrap();
        if rest[..m.start()].trim().is_empty() {
            (
                caps[1].trim().to_string(),
                rest[m.end()..].trim_start_matches('\n').to_string(),
            )
        } else {
            (fallback, rest.to_string())
        }
    } else {
        (fallback, rest.to_string())
    };
    if let Some(t) = meta.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        title = t.to_string();
    }

    let cleaned_body = local_img_re()
        .replace_all(&body_raw, |caps: &regex::Captures| {
            let url = &caps[1];
            if url.starts_with("http://")
                || url.starts_with("https://")
                || url.starts_with("data:")
                || url.starts_with("/api/projects/")
            {
                caps[0].to_string()
            } else {
                String::new()
            }
        })
        .trim()
        .to_string()
        + "\n";

    let aliases = meta
        .get("aliases")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let tags = meta
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let page_type = meta
        .get("type")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_value::<PageType>(json!(s)).ok());
    let status = meta
        .get("status")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_value::<PageStatus>(json!(s)).ok());

    Ok(ImportedPage {
        title: title.chars().take(200).collect(),
        content: cleaned_body,
        aliases,
        tags,
        page_type,
        status,
    })
}
