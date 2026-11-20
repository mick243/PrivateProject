#!/usr/bin/env bash
# 서버에서 배포 묶음을 넣고 서비스를 다시 띄운다 — 첫 설치와 이후 배포가 같은 명령이다.
#
#   sudo bash install-release.sh release-20261001-1200-0de022b.tgz [server.env]
#   sudo SKIP_MIGRATE=1 bash install-release.sh …     # 마이그레이션을 건너뛴다 (DB 를 덤프로 채울 때)
#
# 순서: 풀기 → (server.env 를 .env.local 에 합치기) → DB 점검 · 배포 직전 백업 → 서비스 정지 → 코드 교체
#       → systemd unit 갱신 → 마이그레이션 → 서비스 시작 → /api/health 200 확인
#
# DB 점검은 **서비스를 멈추기 전에** 한다 (2026-11-20 마이그레이션 회의). 기준점(베이스라인)이 없거나 지난
# 배포에서 실패한 마이그레이션이 남아 있으면 migrate deploy 가 멈추는데, 예전에는 그걸 서비스를 멈춘 뒤에야
# 알았다. 적용할 마이그레이션이 있으면 그 직전에 DB 를 덤프해 두고, 실패하면 되돌리는 명령을 찍는다.
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

step "3. DB 점검 · 배포 직전 백업 (서비스는 아직 돌고 있습니다)"
DB_URL="$(tr -d '\r' < "$APP/.env.local" | grep -E '^DATABASE_URL=' | tail -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']\$//g")"
PREDEPLOY_DUMP=""
# 되돌릴 판 — 지금 설치하는 것 말고 가장 최근에 설치한 묶음 (아래에서 이 묶음의 시각을 갱신하기 전에 고른다)
PREV_TGZ="$(ls -1t "$REL"/*.tgz 2>/dev/null | { grep -vxF "$REL/$NAME.tgz" || true; } | awk 'NR == 1')"
if [[ "${SKIP_MIGRATE:-}" == "1" ]]; then
  echo "SKIP_MIGRATE=1 — DB 점검과 백업을 건너뜁니다 (DB 를 덤프로 채우는 첫 설치용)"
else
  [[ -n "$DB_URL" ]] || { echo "✗ $APP/.env.local 에 DATABASE_URL 이 없습니다" >&2; exit 2; }
  # 점검은 묶음에 든 스크립트로 한다 — 묶음의 마이그레이션 목록과 짝이 맞는다. 실패하면 여기서 멈추고
  # 서비스는 그대로 돈다 (종료 코드 3 = 기준점 없음 · 4 = 실패한 마이그레이션 · 2 = DB 접속 불가)
  set +e
  check_out="$(bash "$STAGE/deploy/ncp/predeploy-check.sh" "$DB_URL" "$STAGE/prisma/migrations")"
  check_rc=$?
  set -e
  [[ -n "$check_out" ]] && echo "$check_out"
  if (( check_rc != 0 )); then
    drop_copy
    echo "✗ DB 점검에서 멈췄습니다 (코드 $check_rc) — 서비스와 코드는 그대로입니다. 위 안내대로 고친 뒤 다시 돌리세요." >&2
    exit "$check_rc"
  fi
  PENDING="$(sed -n 's/^PENDING=//p' <<<"$check_out" | tail -1)"
  if (( ${PENDING:-0} > 0 )); then
    BACKUP_DIR="${BACKUP_DIR:-/var/backups/arcade-finder}"
    mkdir -p "$BACKUP_DIR"
    DB_MB=$(( $(psql -w -X -At "$DB_URL" -c "SELECT pg_database_size(current_database())") / 1048576 ))
    BK_FREE_MB="$(df -Pm "$BACKUP_DIR" | awk 'NR == 2 {print $4}')"
    # 덤프(-Fc)는 DB 크기보다 훨씬 작다. DB 크기만큼 여유가 있으면 넉넉하다
    if (( BK_FREE_MB < DB_MB + 100 )); then
      drop_copy
      echo "✗ 배포 직전 백업을 둘 자리가 모자랍니다 — $BACKUP_DIR 남은 ${BK_FREE_MB}MB · DB ${DB_MB}MB. 서비스는 그대로입니다." >&2
      exit 2
    fi
    PREDEPLOY_DUMP="$BACKUP_DIR/pre-deploy-$NAME-$(date +%Y%m%d%H%M%S).dump"
    pg_dump -w -Fc --no-owner --dbname="$DB_URL" --file="$PREDEPLOY_DUMP.tmp"
    mv "$PREDEPLOY_DUMP.tmp" "$PREDEPLOY_DUMP"
    [[ -s "$PREDEPLOY_DUMP" ]] || { drop_copy; echo "✗ 배포 직전 덤프가 비었습니다 — 멈춥니다. 서비스는 그대로입니다." >&2; exit 1; }
    echo "배포 직전 백업: $PREDEPLOY_DUMP ($(du -h "$PREDEPLOY_DUMP" | cut -f1))"
    # 배포 직전 덤프는 3개만 남긴다 (매일 백업은 backup.sh 가 따로 7일치)
    ls -1t "$BACKUP_DIR"/pre-deploy-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f
  else
    echo "적용할 마이그레이션이 없어 배포 직전 백업은 건너뜁니다 (매일 백업: /var/backups/arcade-finder)"
  fi
fi

step "4. 서비스 정지 · 코드 교체"
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

step "5. systemd unit"
install -m 644 "$APP/deploy/arcade-finder.service" /etc/systemd/system/arcade-finder.service
install -m 644 "$APP/deploy/arcade-finder-backup.service" /etc/systemd/system/arcade-finder-backup.service
install -m 644 "$APP/deploy/arcade-finder-backup.timer" /etc/systemd/system/arcade-finder-backup.timer
systemctl daemon-reload
systemctl enable arcade-finder arcade-finder-backup.timer >/dev/null 2>&1
systemctl start arcade-finder-backup.timer

if [[ "${SKIP_MIGRATE:-}" == "1" ]]; then
  step "6. 마이그레이션 건너뜀 (SKIP_MIGRATE=1) — 서비스도 띄우지 않습니다"
  echo "DB 를 채운 뒤 직접: sudo systemctl start arcade-finder"
  exit 0
fi

step "6. 마이그레이션 (prisma migrate deploy)"
# prisma.config.ts 가 .env.local 을 스스로 읽는다 (DATABASE_URL).
# 실패하면 서비스는 멈춘 채다 — 그 자리에서 되돌리는 명령을 찍고 멈춘다. 마이그레이션 하나는 트랜잭션이라
# 실패한 것은 대개 반쯤 남지 않지만, Prisma 는 그 이름을 "실패" 로 적어 두어 다음 deploy 를 막는다(P3009).
if ! sudo -u arcade -H bash -c "cd '$APP' && npm run --silent db:migrate:prisma"; then
  {
    echo
    echo "✗ 마이그레이션이 실패했습니다 — 서비스는 멈춰 있습니다. 위의 Prisma 오류를 먼저 읽으세요."
    echo "  상태 보기:   cd $APP && sudo -u arcade -H npx prisma migrate status"
    echo
    echo "  ▶ 이전 판으로 되돌리기"
    if [[ -n "$PREDEPLOY_DUMP" ]]; then
      echo "    1) DB 를 배포 직전으로:  pg_restore -w --clean --if-exists --no-owner -d \"\$(grep ^DATABASE_URL= $APP/.env.local | cut -d= -f2-)\" $PREDEPLOY_DUMP"
    else
      echo "    1) 배포 직전 덤프가 없습니다(적용할 마이그레이션이 없다고 봤던 경우). 매일 백업: ls -lt /var/backups/arcade-finder"
    fi
    if [[ -n "$PREV_TGZ" ]]; then
      echo "    2) 이전 코드로:          sudo SKIP_MIGRATE=1 bash $APP/deploy/ncp/install-release.sh $PREV_TGZ"
      echo "    3) 서비스 시작:          sudo systemctl start arcade-finder"
    else
      echo "    2) 되돌릴 이전 묶음이 $REL 에 없습니다."
    fi
    echo
    echo "  ▶ 고쳐서 다시 배포할 때는 실패 표시부터 지웁니다(DB 를 복원했으면 필요 없음):"
    echo "       cd $APP && sudo -u arcade -H npx prisma migrate resolve --rolled-back <실패한 이름>"
    echo "  자세한 것: $APP/deploy/README.md 「배포가 멈췄을 때」"
  } >&2
  exit 1
fi

step "7. 서비스 시작 · 확인"
systemctl start arcade-finder
for i in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)"
  if [[ "$code" == "200" ]]; then
    echo "✔ /api/health 200 (${i}×2초) — $(cat "$APP/RELEASE" 2>/dev/null)"
    health="$(curl -s http://127.0.0.1:3000/api/health)"; echo "$health"
    # 떠 있는 것이 **방금 깐 판**인지 — 옛 프로세스가 포트를 쥐고 있으면 200 이어도 옛 코드다.
    # VERSION 은 build-release.sh 가 묶음에 적는다 (옛 묶음에는 없어 건너뛴다).
    want="$(cat "$APP/VERSION" 2>/dev/null || true)"
    if [[ -n "$want" ]] && ! grep -q "\"version\":\"$want\"" <<<"$health"; then
      echo "⚠ 응답한 판이 묶음($want)과 다릅니다 — 옛 프로세스가 남아 있는지 보세요: systemctl restart arcade-finder" >&2
    fi
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
