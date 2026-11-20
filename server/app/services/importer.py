"""외부 문서 → 위키 페이지 가져오기.

- .md/.markdown/.txt: 그대로 (MightyWork 내보내기의 front matter 가 있으면 속성까지 복원)
- .hwp/.hwpx/.docx/.pdf/.pptx/.xlsx: kordoc 으로 Markdown 변환 (OCR 끔)
- 업로드 파일 이름은 제목 후보와 확장자 판별에만 쓰고, 디스크에는 고정 이름으로 임시 저장
- 그림은 아직 첨부 저장소가 없어 가져오지 않는다 (로컬 그림 참조는 제거)
"""

import json
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from app.core.config import Settings
from app.services.export.hangul import ConversionFailed, run_kordoc

TEXT_EXT = {".md", ".markdown", ".txt"}
KORDOC_EXT = {".hwp", ".hwpx", ".docx", ".pdf", ".pptx", ".xlsx"}
ALLOWED_EXT = TEXT_EXT | KORDOC_EXT
MAX_BYTES = 20 * 1024 * 1024

_FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)
_H1 = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.M)
_LOCAL_IMAGE = re.compile(r"!\[[^\]]*\]\((?!https?://|data:)[^)]*\)")


class UnsupportedFile(ValueError):
    pass


@dataclass
class Imported:
    title: str
    content: str
    props: dict = field(default_factory=dict)  # aliases, tags, page_type, status


def _front_matter(md: str) -> tuple[dict, str]:
    m = _FRONT.match(md)
    if not m:
        return {}, md
    data = {}
    for line in m.group(1).splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        value = value.strip()
        try:
            data[key.strip()] = json.loads(value)
        except ValueError:
            data[key.strip()] = value.strip('"')
    return data, md[m.end() :]


def _props(meta: dict) -> dict:
    props = {}
    if isinstance(meta.get("aliases"), list):
        props["aliases"] = [str(a) for a in meta["aliases"]]
    if isinstance(meta.get("tags"), list):
        props["tags"] = [str(t) for t in meta["tags"]]
    if meta.get("type") in {"guide", "spec", "decision", "meeting", "reference", "note"}:
        props["page_type"] = meta["type"]
    if meta.get("status") in {"draft", "review", "published", "deprecated"}:
        props["status"] = meta["status"]
    return props


def _split_title(md: str, fallback: str) -> tuple[str, str]:
    """첫 # 제목을 페이지 제목으로 쓰고 본문에서 뺀다. 없으면 파일 이름."""
    m = _H1.search(md)
    if m and not md[: m.start()].strip():
        return m.group(1).strip(), md[m.end() :].lstrip("\n")
    return fallback, md


def to_page(settings: Settings, filename: str, data: bytes) -> Imported:
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise UnsupportedFile(f"지원하지 않는 형식입니다: {ext or '(확장자 없음)'}")
    stem = re.sub(r"\s+", " ", Path(filename).stem).strip()[:200] or "가져온 문서"

    if ext in TEXT_EXT:
        md = data.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    else:
        with tempfile.TemporaryDirectory(prefix="mw-import-") as tmp:
            src, out = Path(tmp) / f"upload{ext}", Path(tmp) / "out.md"
            src.write_bytes(data)
            run_kordoc(settings, [str(src), "-o", str(out), "--silent"], Path(tmp))
            if not out.is_file():
                raise ConversionFailed("변환 결과가 없습니다")
            md = out.read_text(encoding="utf-8")

    meta, md = _front_matter(md)
    title, body = _split_title(md, str(meta.get("title") or stem))
    if meta.get("title"):
        title = str(meta["title"])
    body = _LOCAL_IMAGE.sub("", body).strip() + "\n"
    return Imported(title=title[:200], content=body, props=_props(meta))
