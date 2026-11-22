#!/usr/bin/env bash
# MightyWork 버전 갱신 스크립트 (SemVer 단일 소스 동기화)
#
# 사용법:
#   ./scripts/bump-version.sh 0.1.1
#   ./scripts/bump-version.sh patch   # 0.1.0 -> 0.1.1
#   ./scripts/bump-version.sh minor   # 0.1.0 -> 0.2.0
#   ./scripts/bump-version.sh major   # 0.1.0 -> 1.0.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ $# -lt 1 ]; then
  echo "사용법: $0 <major|minor|patch|X.Y.Z>" >&2
  exit 1
fi

CURRENT="$(tr -d '[:space:]' < VERSION)"
ARG="$1"

case "$ARG" in
  major|minor|patch)
    IFS='.' read -r MAJ MIN PAT <<< "${CURRENT%%-*}"
    case "$ARG" in
      major) NEXT="$((MAJ + 1)).0.0" ;;
      minor) NEXT="$MAJ.$((MIN + 1)).0" ;;
      patch) NEXT="$MAJ.$MIN.$((PAT + 1))" ;;
    esac
    ;;
  *)
    NEXT="$ARG"
    ;;
esac

if ! [[ "$NEXT" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "올바른 SemVer 형식이 아닙니다: $NEXT (예: 0.1.0)" >&2
  exit 1
fi

printf '%s\n' "$NEXT" > VERSION

python3 - "$NEXT" <<'PY'
import json
import re
import sys
from pathlib import Path

ver = sys.argv[1]

# 1) server/pyproject.toml
py = Path("server/pyproject.toml")
text = py.read_text(encoding="utf-8")
updated, n = re.subn(r'(?m)^version\s*=\s*"[^"]+"', f'version = "{ver}"', text, count=1)
assert n == 1, "server/pyproject.toml version 필드를 찾지 못했습니다"
py.write_text(updated, encoding="utf-8")

# 2) server/uv.lock (mightywork-server 패키지 버전)
uv_lock = Path("server/uv.lock")
if uv_lock.exists():
    lock_txt = uv_lock.read_text(encoding="utf-8")
    lock_upd, ln = re.subn(
        r'(name = "mightywork-server"\nversion = ")[^"]+(")',
        rf'\g<1>{ver}\g<2>',
        lock_txt,
        count=1,
    )
    if ln == 1:
        uv_lock.write_text(lock_upd, encoding="utf-8")

# 3) client/package.json
pkg = Path("client/package.json")
data = json.loads(pkg.read_text(encoding="utf-8"))
data["version"] = ver
pkg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

# 4) client/package-lock.json
plock = Path("client/package-lock.json")
if plock.exists():
    ldata = json.loads(plock.read_text(encoding="utf-8"))
    ldata["version"] = ver
    if isinstance(ldata.get("packages"), dict) and "" in ldata["packages"]:
        ldata["packages"][""]["version"] = ver
    plock.write_text(json.dumps(ldata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

# 5) README.md 상단 버전 표기
readme = Path("README.md")
if readme.exists():
    rtxt = readme.read_text(encoding="utf-8")
    rtxt = re.sub(r"(?m)^# MightyWork `v[^`]+`", f"# MightyWork `v{ver}`", rtxt, count=1)
    rtxt = re.sub(r"(?m)^> 현재 버전: `[^`]+`", f"> 현재 버전: `{ver}`", rtxt, count=1)
    readme.write_text(rtxt, encoding="utf-8")
PY

echo "버전 변경 완료: $CURRENT -> $NEXT"
echo "다음 단계:"
echo "  1. CHANGELOG.md 업데이트"
echo "  2. git add VERSION CHANGELOG.md server/pyproject.toml server/uv.lock client/package.json client/package-lock.json"
echo "  3. git commit -m \"chore: release v$NEXT\" && git tag -a \"v$NEXT\" -m \"Release v$NEXT\""
echo "  4. git push origin main --tags"
