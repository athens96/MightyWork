#!/usr/bin/env bash
# Mighty 앱 공통 배포 스크립트 — MightyTrade·MightyWork 저장소에 같은 파일로 둔다.
# 앱마다 다른 값과 설치 단계는 deploy/app.conf 에만 있다.
#
#   scripts/deploy.sh            업데이트: 서버 git pull·의존성·재시작 + 클라이언트 로컬 빌드 업로드
#   scripts/deploy.sh setup      처음 설치 (여러 번 실행해도 안전): 패키지·clone·.env·systemd·nginx·HTTPS 후 업데이트
#   scripts/deploy.sh status     서비스 상태와 헬스 체크
#   scripts/deploy.sh logs [N]   서비스 로그 마지막 N줄 (기본 100)
#
# 접속 정보: deploy/.env.deploy (git 제외)
#   DEPLOY_HOST=ubuntu@1.2.3.4
#   DEPLOY_KEY=~/.ssh/oci-free
# DEPLOY_YES=1 이면 확인 질문 없이 진행한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f deploy/.env.deploy ] && . deploy/.env.deploy
# shellcheck source=/dev/null
. deploy/app.conf
: "${DEPLOY_HOST:?DEPLOY_HOST 가 없습니다 (deploy/.env.deploy)}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/oci-free}"
DEPLOY_KEY="${DEPLOY_KEY/#\~/$HOME}"
SSH=(ssh -i "$DEPLOY_KEY" -o BatchMode=yes "$DEPLOY_HOST")
URL="https://$DOMAIN"

say() { printf '\n== %s\n' "$*"; }

# 원격에서 bash 로 실행: 앱 변수 + app.conf 의 remote_* 함수 + 넘겨준 본문
remote() {
  local vars="" v
  for v in APP APP_DIR REPO_URL DOMAIN SERVICE ${APP_VARS[@]+"${APP_VARS[@]}"}; do
    vars+="$(printf '%s=%q\n' "$v" "${!v-}")"$'\n'
  done
  { echo "set -euo pipefail"; echo 'export PATH="$HOME/.local/bin:$PATH"'; printf '%s' "$vars"
    declare -F | awk '$3 ~ /^remote_/ {print $3}' | while read -r f; do declare -f "$f"; done
    cat; } | "${SSH[@]}" bash -s
}

confirm_synced() {
  git fetch -q origin main
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || [ -n "$(git status --porcelain)" ]; then
    echo "! 로컬이 origin/main 과 다릅니다 (미커밋 또는 미푸시). 서버는 origin/main 을, 클라이언트는 로컬 빌드를 올립니다." >&2
    [ "${DEPLOY_YES:-}" = 1 ] && return
    read -r -p "계속할까요? [y/N] " ok; [ "$ok" = y ] || exit 1
  fi
}

health() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL$HEALTH_PATH" || true)
  echo "== $URL$HEALTH_PATH -> $code (기대값 $HEALTH_OK)"
  [ "$code" = "$HEALTH_OK" ]
}

cmd_update() {
  confirm_synced
  say "클라이언트 빌드"
  (cd client && npm run build >/dev/null)

  if [ -n "${RUST_BIN_PATH:-}" ] && [ -f "$RUST_BIN_PATH" ]; then
    say "Rust 서버 바이너리 업로드"
    "${SSH[@]}" "mkdir -p $APP_DIR/server-rs"
    rsync -az -e "ssh -i $DEPLOY_KEY -o BatchMode=yes" "$RUST_BIN_PATH" "$DEPLOY_HOST:$APP_DIR/server-rs/mightywork-server.new"
  fi

  say "서버 업데이트"
  remote <<'EOF'
cd "$APP_DIR" && git pull -q --ff-only && git log --oneline -1
remote_install
if ! cmp -s "deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"; then
  sudo cp "deploy/$SERVICE.service" /etc/systemd/system/ && sudo systemctl daemon-reload
fi
sudo systemctl restart "$SERVICE"; sleep 3; systemctl is-active "$SERVICE"
EOF

  say "클라이언트 업로드"
  rsync -az --delete -e "ssh -i $DEPLOY_KEY -o BatchMode=yes" client/dist/ "$DEPLOY_HOST:$APP_DIR/client/dist/"
  health
}

cmd_setup() {
  say "서버 준비 ($APP → $DOMAIN)"
  remote <<'EOF'
need=""
for p in nginx certbot python3-certbot-nginx python3-venv git rsync curl; do dpkg -s "$p" >/dev/null 2>&1 || need+=" $p"; done
[ -n "$need" ] && { echo "apt:$need"; sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need; }
remote_prereqs

if [ ! -d "$APP_DIR/.git" ]; then
  sudo mkdir -p "$APP_DIR" && sudo chown "$(id -un):$(id -gn)" "$APP_DIR"
  git clone -q "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR" && git pull -q --ff-only
mkdir -p client/dist

if [ ! -f server/.env ]; then
  if declare -F remote_env >/dev/null; then
    (umask 077; remote_env > server/.env); echo "server/.env 생성 (권한 600)"
  else
    echo "! server/.env 가 없습니다. README(배포)대로 작성한 뒤 다시 실행하세요." >&2; exit 1
  fi
fi

remote_install
sudo cp "deploy/$SERVICE.service" /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable -q "$SERVICE" && sudo systemctl restart "$SERVICE"

# nginx: 처음에만 템플릿을 놓는다 (이후에는 certbot 이 고친 서버 파일을 그대로 둔다)
site="/etc/nginx/sites-available/$APP"
if [ ! -f "$site" ]; then
  sudo cp deploy/nginx.conf "$site" && sudo ln -sf "$site" "/etc/nginx/sites-enabled/$APP"
  sudo nginx -t -q && sudo systemctl reload nginx && echo "nginx: $site"
fi
if ! sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
  sudo certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos --register-unsafely-without-email
fi
systemctl is-active "$SERVICE"
EOF
  cmd_update
}

cmd_status() {
  remote <<'EOF'
systemctl --no-pager --lines=0 status "$SERVICE" | head -5
cd "$APP_DIR" && git log --oneline -1
EOF
  health
}

cmd_logs() {
  local n="${1:-100}"
  "${SSH[@]}" "sudo journalctl -u $SERVICE -n $n --no-pager"
}

case "${1:-update}" in
  update) cmd_update ;;
  setup) cmd_setup ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
