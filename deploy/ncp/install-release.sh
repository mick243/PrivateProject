#!/usr/bin/env bash
# 서버에서 배포 묶음을 넣고 서비스를 다시 띄운다 — 첫 설치와 이후 배포가 같은 명령이다.
#
#   sudo bash install-release.sh release-20261001-1200-0de022b.tgz [server.env]
#   sudo SKIP_MIGRATE=1 bash install-release.sh …     # 마이그레이션을 건너뛴다 (DB 를 덤프로 채울 때)
#
# 순서: 풀기 → (server.env 를 .env.local 에 합치기) → 서비스 정지 → 코드 교체
#       → systemd unit 갱신 → 마이그레이션 → 서비스 시작 → /api/health 200 확인
#
# 인스턴스가 하나뿐인 작은 서버라 교체하는 10~20초 동안은 접속이 끊긴다.
# 되돌리기: releases/ 에 남은 이전 묶음으로 이 스크립트를 다시 돌리면 된다 (최근 2개 보존).
# ⚠ 마이그레이션은 되돌리지 않는다 — 코드를 되돌려도 스키마는 새 것 그대로다.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "root 로 돌려 주세요: sudo bash $0 <묶음.tgz> [server.env]" >&2; exit 2; fi
TGZ="${1:?배포 묶음(.tgz) 경로를 주세요}"
SERVER_ENV="${2:-}"
[[ -f "$TGZ" ]] || { echo "없음: $TGZ" >&2; exit 2; }

ROOT=/srv/arcade-finder
APP="$ROOT/app/arcade-finder"
REL="$ROOT/releases"
[[ -f "$APP/.env.local" ]] || { echo "$APP/.env.local 이 없습니다 — bootstrap.sh 를 먼저 돌려 주세요" >&2; exit 2; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

NAME="$(basename "$TGZ" .tgz)"
STAGE="$REL/$NAME"

step "1. 풀기 → $STAGE"
mkdir -p "$REL"
[[ "$(realpath "$TGZ")" == "$REL/$NAME.tgz" ]] || cp "$TGZ" "$REL/$NAME.tgz"
rm -rf "$STAGE" && mkdir -p "$STAGE"
tar -xzf "$REL/$NAME.tgz" -C "$STAGE"
[[ -f "$STAGE/package.json" && -d "$STAGE/.next" && -d "$STAGE/node_modules" ]] \
  || { echo "묶음이 이상합니다 — package.json · .next · node_modules 가 다 있어야 합니다" >&2; exit 1; }

if [[ -n "$SERVER_ENV" ]]; then
  step "2. server.env 를 .env.local 에 합치기"
  [[ -f "$SERVER_ENV" ]] || { echo "없음: $SERVER_ENV" >&2; exit 2; }
  cp -p "$APP/.env.local" "$APP/.env.local.bak-$(date +%Y%m%d%H%M%S)"
  # 같은 키는 바꾸고, 없는 키는 뒤에 붙인다. bootstrap 이 만든 운영 값은 server.env 에 없으므로 그대로 남는다
  awk -F= '
    FNR == NR { if ($0 ~ /^[A-Z][A-Z0-9_]*=/) { k = $1; v[k] = $0; order[++n] = k } next }
    /^[A-Z][A-Z0-9_]*=/ && ($1 in v) { print v[$1]; done[$1] = 1; next }
    { print }
    END { for (i = 1; i <= n; i++) if (!(order[i] in done)) print v[order[i]] }
  ' <(tr -d '\r' < "$SERVER_ENV") "$APP/.env.local" > "$APP/.env.local.new"
  install -o arcade -g arcade -m 600 "$APP/.env.local.new" "$APP/.env.local" && rm -f "$APP/.env.local.new"
  echo "합친 키: $(grep -cE '^[A-Z]' "$SERVER_ENV")개 — 올린 server.env 는 이제 지워도 됩니다: rm $SERVER_ENV"
fi

step "3. 서비스 정지 · 코드 교체"
systemctl stop arcade-finder 2>/dev/null || true
# 사용자 파일(uploads) · 운영 설정(.env.local) · 폴백 사본 자리(.pglite)는 교체 대상이 아니다
rsync -a --delete \
  --exclude=/uploads/ --exclude=/.env.local --exclude='/.env.local.bak-*' --exclude=/.pglite/ \
  "$STAGE/" "$APP/"
mkdir -p "$APP/uploads" "$APP/.pglite"
chown -R arcade:arcade "$APP"
# 풀어 둔 사본은 지운다 — 디스크 10GB 서버에서 700MB 짜리가 하나 더 남으면 아깝다. 묶음(.tgz)은 남긴다
rm -rf "$STAGE"
cat "$APP/RELEASE" 2>/dev/null || true

step "4. systemd unit"
install -m 644 "$APP/deploy/arcade-finder.service" /etc/systemd/system/arcade-finder.service
install -m 644 "$APP/deploy/arcade-finder-backup.service" /etc/systemd/system/arcade-finder-backup.service
install -m 644 "$APP/deploy/arcade-finder-backup.timer" /etc/systemd/system/arcade-finder-backup.timer
systemctl daemon-reload
systemctl enable arcade-finder arcade-finder-backup.timer >/dev/null 2>&1
systemctl start arcade-finder-backup.timer

if [[ "${SKIP_MIGRATE:-}" == "1" ]]; then
  step "5. 마이그레이션 건너뜀 (SKIP_MIGRATE=1) — 서비스도 띄우지 않습니다"
  echo "DB 를 채운 뒤 직접: sudo systemctl start arcade-finder"
  exit 0
fi

step "5. 마이그레이션 (prisma migrate deploy)"
# prisma.config.ts 가 .env.local 을 스스로 읽는다 (DATABASE_URL)
sudo -u arcade -H bash -c "cd '$APP' && npm run --silent db:migrate:prisma"

step "6. 서비스 시작 · 확인"
systemctl start arcade-finder
for i in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)"
  if [[ "$code" == "200" ]]; then
    echo "✔ /api/health 200 (${i}×2초) — $(cat "$APP/RELEASE" 2>/dev/null)"
    curl -s http://127.0.0.1:3000/api/health; echo
    break
  fi
  sleep 2
done
if [[ "${code:-}" != "200" ]]; then
  echo "✗ 90초 안에 뜨지 않았습니다 (마지막 응답 ${code:-없음}). 로그:" >&2
  journalctl -u arcade-finder -n 40 --no-pager >&2
  exit 1
fi

# 묶음은 최근 2개만 남긴다 (지금 것 + 되돌릴 하나). 디스크 10GB 서버 기준
ls -1t "$REL"/*.tgz 2>/dev/null | tail -n +3 | xargs -r rm -f
df -h / | awk 'NR==2 {print "디스크: " $3 " 사용 / " $2 " (" $5 ")"}'
free -m | awk 'NR<=2'
