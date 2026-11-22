"""애플리케이션 버전 단일 소스 로더 (루트 VERSION → server/pyproject.toml → 패키지 메타데이터)."""

from importlib.metadata import PackageNotFoundError, version as pkg_version
from pathlib import Path
import tomllib

_FALLBACK_VERSION = "0.1.0"


def get_version() -> str:
    here = Path(__file__).resolve()
    # 1) 저장소 루트 VERSION 파일 우선
    for parent in here.parents:
        vf = parent / "VERSION"
        if vf.is_file():
            val = vf.read_text(encoding="utf-8").strip()
            if val:
                return val
    # 2) Docker 등 server/ 단독 빌드 시 server/pyproject.toml 참조
    for parent in here.parents:
        pf = parent / "pyproject.toml"
        if pf.is_file():
            try:
                data = tomllib.loads(pf.read_text(encoding="utf-8"))
                val = str((data.get("project") or {}).get("version", "")).strip()
                if val:
                    return val
            except Exception:
                pass
    # 3) 설치된 배포 메타데이터 폴백
    try:
        return pkg_version("mightywork-server")
    except PackageNotFoundError:
        return _FALLBACK_VERSION


APP_VERSION = get_version()
