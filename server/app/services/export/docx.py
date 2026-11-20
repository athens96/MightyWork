"""Word(.docx) 내보내기 — pandoc (pypandoc-binary 에 포함된 실행 파일).

- 본문은 GFM 으로 읽어 표·체크리스트·취소선을 유지한다
- [[링크]] 는 표시 텍스트로 풀고, 하위 페이지는 제목 단계를 내려 하나의 문서로
- --sandbox: 문서 속 이미지 경로로 서버의 로컬 파일/외부 URL 을 읽어 오지 못하게 막는다
- 기본 서식 문서의 동아시아 언어를 ko-KR 로 바꿔 한글이 '맑은 고딕'(테마 Hang 글꼴)으로 보이게 한다
"""

import functools
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pypandoc

from app.db import Database
from app.models.project import Project
from app.services.export.prepare import PageBlock, resolve_links, shift_headings

TIMEOUT_SEC = 60

_BORDER = '<w:{side} w:val="single" w:sz="4" w:space="0" w:color="B9C0CC"/>'
# pandoc 이 표에 쓰는 'Table' 스타일: 기본은 테두리가 없어 표가 글처럼 보인다 → 테두리·머리글 음영 추가
TABLE_STYLE = (
    '<w:style w:type="table" w:customStyle="1" w:styleId="Table"><w:name w:val="Table"/><w:basedOn w:val="TableNormal"/>'
    "<w:tblPr><w:tblBorders>"
    + "".join(_BORDER.format(side=s) for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
    + '</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>'
    '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F5F7FB"/></w:tcPr></w:tblStylePr>'
    "</w:style>"
)


@functools.cache
def reference_docx() -> Path:
    """pandoc 기본 reference.docx 를 한국어 기본값으로 고친 사본 (프로세스당 1회 생성)."""
    pandoc = pypandoc.get_pandoc_path()
    raw = subprocess.run([pandoc, "--print-default-data-file", "reference.docx"], capture_output=True, check=True, timeout=TIMEOUT_SEC).stdout
    src = Path(tempfile.mkdtemp(prefix="mw-ref-")) / "default.docx"
    src.write_bytes(raw)
    dst = src.with_name("reference-ko.docx")
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/styles.xml":
                xml = data.decode().replace('w:eastAsia="zh-CN"', 'w:eastAsia="ko-KR"')
                xml = re.sub(r'<w:style w:type="table"[^>]*w:styleId="Table".*?</w:style>', TABLE_STYLE, xml, count=1, flags=re.S)
                data = xml.encode()
            zout.writestr(item, data)
    return dst


def to_markdown(db: Database, project: Project, blocks: list[PageBlock]) -> str:
    parts = []
    for b in blocks:
        hashes = "#" * min(b.depth + 1, 6)
        meta = " · ".join(f"{k}: {v}" for k, v in b.meta)
        body = shift_headings(resolve_links(b.page.content, db, project, None), b.depth + 1)
        parts.append(f"{hashes} {b.page.title}\n\n*{meta}*\n\n{body}\n")
    return "\n".join(parts)


def render_docx(db: Database, project: Project, blocks: list[PageBlock]) -> bytes:
    md = to_markdown(db, project, blocks)
    with tempfile.TemporaryDirectory(prefix="mw-docx-") as tmp:
        out = Path(tmp) / "out.docx"
        pypandoc.convert_text(
            md,
            "docx",
            format="gfm",
            outputfile=str(out),
            extra_args=["--sandbox", f"--reference-doc={reference_docx()}"],
        )
        return out.read_bytes()
