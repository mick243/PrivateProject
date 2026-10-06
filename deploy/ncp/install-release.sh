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
# 되돌리기: releases/ 에 남은 이전 묶음으로 이 스크립트를 다시 돌리면 된다 (지금 것 + 그 전에 설치한 것, 2개 보존).
# 설치가 끝나면 올린 원본(/root 의 .tgz)은 지운다 — 같은 것이 releases/ 에 있다. 실패하면 그대로 둔다.
# ⚠ 마이그레이션은 되돌리지 않는다 — 코드를 되돌려도 스키마는 새 것 그대로다.
set -Eeuo pipefail
# set -e 는 멈출 때 아무 말도 하지 않는다. 어느 줄의 무슨 명령에서 멈췄는지 반드시 남긴다.
# -E 라 $(…) 안에서도 불리는데, 거기서는 파이프 조각을 엉뚱하게 가리키므로 바깥에서만 찍는다
trap 'rc=$?; [[ $BASH_SUBSHELL -eq 0 ]] && echo "✗ install-release.sh ${LINENO}번째 줄에서 멈췄습니다 (종료 코드 $rc): $BASH_COMMAND" >&2' ERR

if [[ $EUID -ne 0 ]]; then echo "root 로 돌려 주세요: sudo bash $0 <묶음.tgz> [server.env]" >&2; exit 2; fi
# release-*.tgz 로 쓰면 묶음이 여럿일 때 전부 인자로 펼쳐져, 이름순으로 **옛 묶음**이 설치되고 새 묶음이
# server.env 자리에 들어간다 (2026-09-30 실서버에서 당함). 묶음은 하나만, 둘째 인자는 .tgz 가 아니어야 한다.
if (( $# < 1 || $# > 2 )) || [[ "${2:-}" == *.tgz ]]; then
  echo "배포 묶음(.tgz)은 하나만 주세요 — 받은 인자 $#개: $*" >&2
  echo "  예: sudo bash $0 release-20260930-1102-099cf0d.tgz server.env" >&2
  exit 2
fi
TGZ="$1"
SERVER_ENV="${2:-}"

ROOT=/srv/arcade-finder
APP="$ROOT/app/arcade-finder"
REL="$ROOT/releases"
if [[ ! -f "$TGZ" ]]; then
  echo "없음: $TGZ — PC 에서 scp 로 올렸는지, 지금 폴더($PWD)가 맞는지 보세요." >&2
  found="$(ls -1t ./*.tgz "$REL"/*.tgz 2>/dev/null | awk 'NR <= 5' || true)"
  if [[ -n "$found" ]]; then echo "  이 서버에 있는 묶음:" >&2; sed 's/^/    /' <<<"$found" >&2
  else echo "  이 서버에는 묶음이 하나도 없습니다." >&2; fi
  exit 2
fi
# server.env 가 없는 걸 풀고 나서야 알면 디스크만 쓰고 멈춘다 — 먼저 본다
[[ -z "$SERVER_ENV" || -f "$SERVER_ENV" ]] || { echo "없음: $SERVER_ENV — PC 의 deploy/ncp/server.env 를 scp 로 올려 주세요" >&2; exit 2; }
# .env.local 은 bootstrap.sh 의 5단계가 만든다. 돌렸는데도 없으면 bootstrap 이 그 전에 멈춘 것이다
[[ -f "$APP/.env.local" ]] || {
  echo "$APP/.env.local 이 없습니다 — bootstrap.sh 가 끝까지 돌지 않았습니다." >&2
  echo "  sudo SITE_DOMAIN=<공인IP-대시>.sslip.io bash bootstrap.sh 를 돌리고, 마지막에 '✔ 준비 끝' 이 나오는지 보세요." >&2
  exit 2
}
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

NAME="$(basename "$TGZ" .tgz)"
STAGE="$REL/$NAME"

# 디스크 여유 — 풀어 둔 사본과, 앱 폴더가 커지는 만큼이 한꺼번에 필요하다. 10GB 서버에서 1.5GB 짜리 묶음을
# 넣다가 rsync 도중 "No space left on device" 로 멈춘 적이 있다(2026-09-30). 모자라면 아무것도 건드리기 전에 멈춘다.
TGZ_MB=$(( $(stat -c %s "$TGZ") / 1048576 ))
# 올리다 끊긴 묶음은 gzip -l 부터 실패한다 — 그대로 두면 산술 오류로 알 수 없게 멈추므로 여기서 말하고 멈춘다
RAW_B="$(gzip -l "$TGZ" 2>/dev/null | awk 'NR == 2 {print $2}')" \
  || { echo "묶음이 깨졌습니다 — 올리다 끊겼을 수 있습니다. 크기(${TGZ_MB}MB)를 PC 의 것과 비교하고 다시 올리세요" >&2; exit 2; }
RAW_MB=$(( RAW_B / 1048576 ))                                          # 풀었을 때 크기
(( RAW_MB < TGZ_MB )) && RAW_MB=$(( TGZ_MB * 4 ))                     # gzip -l 은 4GB 를 넘으면 틀린다
APP_MB="$( { du -sm --exclude=uploads "$APP" 2>/dev/null || true; } | awk '{print $1}')"
APP_MB="${APP_MB:-0}"
# 묶음 사본은 releases/ 밖에서 왔고 다른 디스크일 때만 공간을 먹는다 (같은 디스크면 아래에서 하드링크)
COPY_MB=$TGZ_MB
if [[ "$(realpath "$TGZ")" == "$REL/$NAME.tgz" || "$(stat -c %d "$TGZ")" == "$(stat -c %d "$ROOT")" ]]; then COPY_MB=0; fi
NEED_MB=$(( COPY_MB + RAW_MB + (RAW_MB > APP_MB ? RAW_MB - APP_MB : 0) + 300 ))
FREE_MB="$(df -Pm "$ROOT" | awk 'NR == 2 {print $4}')"
if (( FREE_MB < NEED_MB )); then
  echo "디스크가 모자랍니다 — 남은 ${FREE_MB}MB, 필요 ${NEED_MB}MB (묶음 ${TGZ_MB}MB · 풀면 ${RAW_MB}MB)" >&2
  echo "  지워도 되는 것: 다 쓴 묶음(ls -la /root $REL) · 풀다 만 폴더($REL/release-*/) · apt 캐시(apt-get clean)" >&2
  exit 2
fi

step "1. 풀기 → $STAGE"
mkdir -p "$REL"
# 중간에 멈추면 풀어 둔 사본을 지운다 — 작은 디스크에 1GB 가까운 찌꺼기가 남지 않게 (끝까지 가도 아래에서 지운다)
trap 'rm -rf "$STAGE"' EXIT
# 쓸 수 없는 묶음이면 releases/ 에 만든 사본도 지운다 (releases/ 안의 것을 직접 준 경우는 그대로 둔다)
drop_copy() { [[ "$(realpath "$TGZ")" == "$REL/$NAME.tgz" ]] || rm -f "$REL/$NAME.tgz"; }
# 같은 디스크면 하드링크 — 사본이 공간을 한 벌 더 먹지 않는다 (/root 의 원본을 지워도 이쪽은 남는다)
[[ "$(realpath "$TGZ")" == "$REL/$NAME.tgz" ]] || ln -f "$TGZ" "$REL/$NAME.tgz" 2>/dev/null || cp "$TGZ" "$REL/$NAME.tgz"
rm -rf "$STAGE" && mkdir -p "$STAGE"
# 풀지 못한 묶음의 사본을 남기면 다음 설치 때 "되돌릴 판" 으로 남을 수 있다
tar -xzf "$REL/$NAME.tgz" -C "$STAGE" \
  || { echo "묶음을 풀지 못했습니다 — 올리다 끊겼으면 크기를 PC 의 것과 비교하세요 (ls -l $TGZ)" >&2; drop_copy; exit 1; }
[[ -f "$STAGE/package.json" && -d "$STAGE/.next" && -d "$STAGE/node_modules" ]] \
  || { echo "묶음이 이상합니다 — package.json · .next · node_modules 가 다 있어야 합니다" >&2; drop_copy; exit 1; }
# 비밀이 든 묶음은 넣지 않는다 — 2026-09-29 묶음에 옛 워크트리의 .env.local 이 실렸다 (build-release.sh 도 막는다).
# head 로 자르면 find 가 SIGPIPE 로 끝나 pipefail 에 걸리므로 awk 로 자른다
leak="$(find "$STAGE" -path "$STAGE/node_modules" -prune -o -name ".env*" ! -name ".env.example" -print -o -name "*.env" -print -o -name "*.pem" -print -o -name .claude -print | awk 'NR <= 5')"
if [[ -n "$leak" ]]; then
  echo "이 묶음에는 들어가면 안 되는 파일이 있어 넣지 않습니다 — PC 에서 build-release.sh 최신 판으로 다시 빌드하세요:" >&2
  sed "s#^$STAGE/#  #" <<<"$leak" >&2
  drop_copy
  echo "  올린 묶음($TGZ)도 지워 주세요." >&2
  exit 1
fi

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

# 올린 원본(/root 등)은 지운다 — releases/ 에 같은 것(하드링크나 사본)이 남는다. 하드링크라서 원본을 두면
# 아래에서 releases/ 쪽을 지워도 공간이 비지 않는다: /root 에 묶음이 쌓여 디스크 여유가 14% 가 됐다(2026-10-06)
if [[ "$(realpath "$TGZ")" != "$REL/$NAME.tgz" ]] && { [[ "$TGZ" -ef "$REL/$NAME.tgz" ]] || cmp -s "$TGZ" "$REL/$NAME.tgz"; }; then
  rm -f "$TGZ" && echo "올린 묶음을 지웠습니다 — 같은 것이 $REL/$NAME.tgz 에 있습니다"
fi

# 묶음은 2개만 남긴다 — 지금 것 + 그 전에 설치한 것(되돌릴 하나). 디스크 10GB 서버 기준
# 시각을 "설치한 때" 로 맞춰 고른다. 올린 시각으로 고르면 옛 묶음으로 되돌린 직후 지금 것이 지워진다
touch "$REL/$NAME.tgz"
ls -1t "$REL"/*.tgz 2>/dev/null | { grep -vxF "$REL/$NAME.tgz" || true; } | tail -n +2 | xargs -r rm -f
df -h / | awk 'NR==2 {print "디스크: " $3 " 사용 / " $2 " (" $5 ")"}'
free -m | awk 'NR<=2'
