"""한글(HWPX/HWP) 변환 — kordoc(MIT) CLI 를 하위 프로세스로 호출한다.

- 생성: Markdown → `kordoc generate` (공문서 프리셋) → .hwpx / .hwp(@rhwp/core 사용)
- 읽기: HWP·HWPX·DOCX·PDF … → `kordoc <file>` → Markdown (위키 가져오기)
- 셸을 거치지 않고 인자 배열로 실행, 임시 폴더 안에서만 읽고 쓰며, 시간 제한을 둔다
"""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from app.core.config import Settings
from app.db import Database
from app.models.project import Project
from app.services.export.prepare import PageBlock, resolve_links, shift_headings

# kordoc 공문서 프리셋 (영문 이름으로 전달)
PRESETS = ("report", "minutes", "plan", "notice", "official", "gaejosik", "press")
PRESET_BY_PAGE_TYPE = {"meeting": "minutes"}

_FENCE = re.compile(r"^\s{0,3}(```|~~~)")
_TASK = re.compile(r"^(\s*[-*+]\s+)\[([ xX])\]\s+")


class ConverterUnavailable(RuntimeError):
    """kordoc 또는 node 가 설치되지 않음."""


class ConversionFailed(RuntimeError):
    pass


def _command(settings: Settings) -> list[str]:
    node = shutil.which(settings.kordoc_node)
    if node is None:
        raise ConverterUnavailable("Node.js 를 찾을 수 없습니다 (KORDOC_NODE)")
    if not settings.kordoc_cli.is_file():
        raise ConverterUnavailable("kordoc 이 설치되지 않았습니다 — server/tools/kordoc 에서 `npm ci` 를 실행하세요")
    return [node, str(settings.kordoc_cli)]


def run_kordoc(settings: Settings, args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            [*_command(settings), *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=settings.kordoc_timeout_sec,
        )
    except subprocess.TimeoutExpired as e:
        raise ConversionFailed("변환 시간이 초과되었습니다") from e
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-3:]
        raise ConversionFailed(" / ".join(tail) or f"kordoc 종료 코드 {result.returncode}")
    return result


def available(settings: Settings) -> bool:
    try:
        _command(settings)
        return True
    except ConverterUnavailable:
        return False


def _tasks_to_symbols(md: str) -> str:
    """`- [x] 항목` → `- ☑ 항목` (kordoc 은 체크리스트 문법을 글자 그대로 출력하므로)."""
    out, in_code = [], False
    for line in md.split("\n"):
        if _FENCE.match(line):
            in_code = not in_code
        elif not in_code:
            line = _TASK.sub(lambda m: m.group(1) + ("☑ " if m.group(2) in "xX" else "☐ "), line)
        out.append(line)
    return "\n".join(out)


def to_markdown(db: Database, project: Project, blocks: list[PageBlock]) -> str:
    parts = []
    for b in blocks:
        hashes = "#" * min(b.depth + 1, 6)
        meta = " · ".join(f"{k}: {v}" for k, v in b.meta)
        body = shift_headings(resolve_links(b.page.content, db, project, None), b.depth + 1)
        parts.append(f"{hashes} {b.page.title}\n\n{meta}\n\n{_tasks_to_symbols(body)}\n")
    return "\n".join(parts)


def pick_preset(blocks: list[PageBlock], requested: str | None) -> str:
    if requested:
        return requested
    page_type = blocks[0].page.page_type
    return PRESET_BY_PAGE_TYPE.get(page_type.value if page_type else "", "report")


def render_hangul(settings: Settings, db: Database, project: Project, blocks: list[PageBlock], fmt: str, preset: str | None) -> bytes:
    """fmt: "hwpx" | "hwp"."""
    with tempfile.TemporaryDirectory(prefix="mw-hwp-") as tmp:
        src, out = Path(tmp) / "in.md", Path(tmp) / f"out.{fmt}"
        src.write_text(to_markdown(db, project, blocks), encoding="utf-8")
        run_kordoc(settings, ["generate", str(src), "-o", str(out), "--preset", pick_preset(blocks, preset)], Path(tmp))
        if not out.is_file():
            raise ConversionFailed("변환 결과 파일이 만들어지지 않았습니다")
        return out.read_bytes()
