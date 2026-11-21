#!/usr/bin/env bash
# Oracle VM 을 origin/main 으로 업데이트: 서버 코드·의존성·kordoc, systemd 유닛, nginx 설정, 클라이언트 빌드.
#
# 설정은 deploy/.env.deploy (git 제외), 예:
#   DEPLOY_HOST=ubuntu@1.2.3.4
#   DEPLOY_KEY=~/.ssh/oci-free
#   DEPLOY_URL=https://mightywork.duckdns.org
# 처음 한 번 서버 준비는 README (배포) 참고.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/deploy/.env.deploy" ] && . "$ROOT/deploy/.env.deploy"
: "${DEPLOY_HOST:?DEPLOY_HOST is not set (deploy/.env.deploy)}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/oci-free}"
DEPLOY_KEY="${DEPLOY_KEY/#\~/$HOME}"
APP_DIR=/opt/mighty-work
SSH=(ssh -i "$DEPLOY_KEY" -o BatchMode=yes "$DEPLOY_HOST")

cd "$ROOT"
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || [ -n "$(git status --porcelain)" ]; then
  echo "! 로컬이 origin/main과 다릅니다 (미커밋 또는 미푸시). 서버는 origin/main을, 클라이언트는 로컬 빌드를 올립니다." >&2
  read -r -p "계속할까요? [y/N] " ok; [ "$ok" = y ] || exit 1
fi

echo "== client build"
(cd client && npm run build >/dev/null)

echo "== server update"
"${SSH[@]}" "set -e
  export PATH=\$HOME/.local/bin:\$PATH
  cd $APP_DIR && git pull -q --ff-only && git log --oneline -1
  (cd server && uv sync -q --frozen --no-dev)
  (cd server/tools/kordoc && npm ci --omit=dev --silent)
  if ! cmp -s deploy/mighty-work-api.service /etc/systemd/system/mighty-work-api.service; then
    sudo cp deploy/mighty-work-api.service /etc/systemd/system/ && sudo systemctl daemon-reload
  fi
  sudo systemctl restart mighty-work-api && sleep 3 && systemctl is-active mighty-work-api"

echo "== client upload"
rsync -az --delete -e "ssh -i $DEPLOY_KEY -o BatchMode=yes" client/dist/ "$DEPLOY_HOST:$APP_DIR/client/dist/"

if [ -n "${DEPLOY_URL:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$DEPLOY_URL/api/health")
  echo "== $DEPLOY_URL/api/health -> $code (200 = 정상)"
fi
