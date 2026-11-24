#!/usr/bin/env bash
# 복구 리허설 — 백업 덤프 · 첨부 묶음을 **임시 DB · 임시 폴더**에 되살려 보고, 확인이 끝나면 지운다.
#
#   sudo bash restore-rehearsal.sh                       # 가장 최근 백업으로
#   sudo bash restore-rehearsal.sh <db-….dump> [uploads-….tar.zst]
#   sudo NO_APP=1 bash restore-rehearsal.sh              # 앱을 띄워 보는 단계를 건너뛴다(메모리가 빠듯할 때)
#   sudo KEEP=1 bash restore-rehearsal.sh                # 끝나도 임시 DB · 폴더를 남긴다(실제 복구로 이어갈 때)
#
# 운영 DB · 운영 첨부 · 서비스는 **건드리지 않는다** — 운영 DB 에는 행 수를 세는 SELECT 만 보낸다.
# 하는 일 (deploy/README.md §4 의 1~3 단계를 자동으로):
#   1. 덤프 → 새 DB(arcade_finder_rehearsal)에 pg_restore. 걸린 시간을 잰다
#   2. 표마다 행 수를 운영 DB 와 나란히 · 마이그레이션 이력이 같은지
#   3. 첨부 묶음 → /var/tmp 에 풀고, 복원한 DB 가 가리키는 첨부 파일이 전부 있는지
#   4. 복원한 DB 로 앱을 3900 번에 하나 더 띄워 health · 오락실 · 글 · 서열표가 열리는지 (운영 앱과 같은 코드)
#   5. 지우기 (KEEP=1 이면 남김)
# 결과는 화면과 $BACKUP_DIR/restore-rehearsal-<시각>.log 에 남는다.
#
# 1GB 서버에서 4단계는 앱 하나(약 250MB)를 더 띄운다. 남은 메모리+스왑이 600MB 보다 적으면 알아서 건너뛴다.
set -Eeuo pipefail
trap 'rc=$?; [[ $BASH_SUBSHELL -eq 0 ]] && echo "✗ restore-rehearsal.sh ${LINENO}번째 줄에서 멈췄습니다 (종료 코드 $rc): $BASH_COMMAND" >&2' ERR
if [[ $EUID -ne 0 ]]; then echo "root 로 돌려 주세요: sudo bash $0" >&2; exit 2; fi

APP=/srv/arcade-finder/app/arcade-finder
BACKUP_DIR="${BACKUP_DIR:-/var/backups/arcade-finder}"
RDB=arcade_finder_rehearsal
WORK=/var/tmp/arcade-restore-rehearsal
PORT_R=3900
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$BACKUP_DIR/restore-rehearsal-$STAMP.log"
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
secs() { echo $(( $(date +%s) - $1 )); }

[[ -f "$APP/.env.local" ]] || { echo "없음: $APP/.env.local — 서버에 앱이 설치돼 있어야 합니다" >&2; exit 2; }
LIVE_URL="$(grep -E '^DATABASE_URL=' "$APP/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
[[ -n "$LIVE_URL" ]] || { echo "$APP/.env.local 에 DATABASE_URL 이 없습니다" >&2; exit 2; }
LIVE_DB="${LIVE_URL##*/}"; LIVE_DB="${LIVE_DB%%\?*}"
R_URL="${LIVE_URL%/*}/$RDB"
# 운영 DB 와 같은 이름이면 아래 DROP 이 운영을 지운다 — 절대 같으면 안 된다
[[ "$LIVE_DB" != "$RDB" ]] || { echo "운영 DB 이름이 $RDB 입니다 — 리허설 이름을 바꿔 주세요" >&2; exit 2; }

DUMP="${1:-$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1 || true)}"
UPL="${2:-$(ls -1t "$BACKUP_DIR"/uploads-*.tar.* 2>/dev/null | head -1 || true)}"
[[ -n "$DUMP" && -f "$DUMP" ]] || { echo "DB 덤프가 없습니다 ($BACKUP_DIR/db-*.dump). 먼저: sudo systemctl start arcade-finder-backup" >&2; exit 2; }

if sudo -u postgres psql -Atqc "SELECT 1 FROM pg_database WHERE datname='$RDB'" | grep -q 1; then
  echo "$RDB 가 이미 있습니다 — 지난 리허설이 KEEP=1 이었거나 중간에 멈췄습니다." >&2
  echo "  지우려면: sudo -u postgres dropdb $RDB && sudo rm -rf $WORK" >&2
  exit 2
fi

# 자리 — 복원한 DB 는 덤프의 약 5배, 첨부는 묶음의 약 1배. 넉넉히 보고 모자라면 시작하지 않는다
need_kb=$(( $(du -k "$DUMP" | cut -f1) * 6 + ( ${UPL:+$(du -k "$UPL" | cut -f1)} + 0 ) * 2 + 200 * 1024 ))
free_kb=$(df -Pk /var | awk 'NR==2 {print $4}')
if (( free_kb < need_kb )); then
  echo "디스크 여유 $(( free_kb / 1024 ))MB < 필요 $(( need_kb / 1024 ))MB — 옛 백업이나 묶음을 정리한 뒤 다시" >&2; exit 2
fi

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$LOG") 2>&1
echo "복구 리허설 $STAMP"
echo "  덤프   $DUMP ($(du -h "$DUMP" | cut -f1), $(date -r "$DUMP" '+%F %T'))"
echo "  첨부   ${UPL:-(없음)}${UPL:+ ($(du -h "$UPL" | cut -f1))}"
echo "  운영 DB $LIVE_DB → 리허설 DB $RDB"

APP_PID=""
cleanup() {
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null && sleep 1 && pkill -f "next start -p $PORT_R" 2>/dev/null || true
  if [[ "${KEEP:-}" == "1" ]]; then
    echo; echo "KEEP=1 — 남겨 둠: DB $RDB · 폴더 $WORK (지우기: sudo -u postgres dropdb $RDB && sudo rm -rf $WORK)"
  else
    sudo -u postgres dropdb --if-exists "$RDB" 2>/dev/null || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

step "1. 덤프를 새 DB 로 복원"
t0=$(date +%s)
sudo -u postgres createdb -O arcade "$RDB"
# 덤프는 --no-owner 로 떴다(deploy/backup.sh) — arcade 로 복원하면 객체 주인도 arcade
if ! pg_restore -w --no-owner --exit-on-error -d "$R_URL" "$DUMP"; then
  echo "✗ pg_restore 실패 — 이 덤프로는 복구할 수 없습니다. 위 오류를 보세요" >&2; exit 1
fi
T_DB=$(secs "$t0")
echo "✔ 복원 ${T_DB}초 · 크기 $(sudo -u postgres psql -Atqc "SELECT pg_size_pretty(pg_database_size('$RDB'))")"

step "2. 운영 DB 와 행 수 비교 (운영은 백업 뒤에도 쓰였으므로 늘어난 만큼의 차이는 정상)"
count_sql="SELECT format('SELECT %L, count(*) FROM public.%I', relname, relname) FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname"
rows() { # $1 = URL → "표 행수" 줄들
  psql -w -Atq -d "$1" -c "$count_sql" | while read -r q; do psql -w -Atq -F' ' -d "$1" -c "$q"; done
}
rows "$LIVE_URL" | sort > "$WORK.live"
rows "$R_URL" | sort > "$WORK.rest"
printf '%-34s %10s %10s  %s\n' "표" "운영" "복원" ""
TABLES=0; DIFF=0; MISSING=0
while read -r t live; do
  rest="$(awk -v t="$t" '$1==t {print $2}' "$WORK.rest")"
  mark=""
  if [[ -z "$rest" ]]; then mark="✗ 복원본에 없음"; MISSING=$((MISSING+1)); rest="-"
  elif [[ "$rest" != "$live" ]]; then mark="Δ $(( live - rest ))"; DIFF=$((DIFF+1)); fi
  TABLES=$((TABLES+1))
  # 행이 있는 표와 차이가 난 표만 찍는다 (빈 표 40개를 다 늘어놓지 않음)
  [[ "$live" != "0" || -n "$mark" ]] && printf '%-34s %10s %10s  %s\n' "$t" "$live" "$rest" "$mark"
done < "$WORK.live"
rm -f "$WORK.live" "$WORK.rest"
mig() { psql -w -Atq -d "$1" -c "SELECT count(*) || ' · ' || coalesce(max(migration_name),'-') FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo "(이력 표 없음)"; }
M_LIVE="$(mig "$LIVE_URL")"; M_REST="$(mig "$R_URL")"
echo "마이그레이션 이력  운영 $M_LIVE"
echo "                  복원 $M_REST"
[[ "$M_LIVE" == "$M_REST" ]] || echo "  ↳ 다릅니다 — 백업 뒤에 배포가 있었다면 정상. 아니라면 덤프가 옛것입니다"
echo "표 ${TABLES}개 · 행 수가 다른 표 ${DIFF}개 · 복원본에 없는 표 ${MISSING}개"
(( MISSING == 0 )) || { echo "✗ 복원본에 없는 표가 있습니다 — 덤프가 운영 스키마보다 옛것이거나 깨졌습니다" >&2; exit 1; }

step "3. 첨부 묶음 풀기 · 빠진 파일 찾기"
T_UPL=0; UPL_MISSING=0
if [[ -n "$UPL" ]]; then
  t0=$(date +%s)
  mkdir -p "$WORK"
  case "$UPL" in
    *.zst) tar --zstd -xf "$UPL" -C "$WORK" ;;
    *)     tar -xzf "$UPL" -C "$WORK" ;;
  esac
  T_UPL=$(secs "$t0")
  files=$(find "$WORK/uploads" -type f 2>/dev/null | wc -l)
  echo "✔ 풀기 ${T_UPL}초 · 파일 ${files}개 ($(du -sh "$WORK/uploads" 2>/dev/null | cut -f1))"
  # 복원한 DB 가 가리키는 첨부(post_images.storage_key)가 묶음 안에 다 있어야 복구가 된 것이다
  psql -w -Atq -d "$R_URL" -c "SELECT DISTINCT storage_key FROM post_images" > "$WORK.keys"
  refs=$(wc -l < "$WORK.keys")
  while read -r k; do [[ -f "$WORK/uploads/posts/$k" ]] || UPL_MISSING=$((UPL_MISSING+1)); done < "$WORK.keys"
  rm -f "$WORK.keys"
  echo "DB 가 가리키는 첨부 ${refs}개 중 묶음에 없는 것 ${UPL_MISSING}개"
  (( UPL_MISSING == 0 )) || echo "  ↳ 덤프와 묶음의 시각이 다르면(같은 날 다른 시각) 그 사이 올라온 첨부가 빠질 수 있습니다"
else
  echo "첨부 묶음이 없습니다 — 건너뜀 (uploads 폴더가 없던 서버면 정상)"
fi

step "4. 복원한 DB 로 앱 띄워 보기 (${PORT_R}번 · 운영 앱은 그대로)"
T_APP="-"; APP_OK="건너뜀"
avail_mb=$(( ( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) + $(awk '/SwapFree/ {print $2}' /proc/meminfo) ) / 1024 ))
if [[ "${NO_APP:-}" == "1" ]]; then
  echo "NO_APP=1 — 건너뜀"
elif (( avail_mb < 600 )); then
  echo "남은 메모리+스왑 ${avail_mb}MB < 600MB — 운영 앱을 밀어낼 수 있어 건너뜀 (NO_APP 없이 한가할 때 다시)"
else
  t0=$(date +%s)
  # 운영 앱과 같은 폴더 · 같은 코드. DATABASE_URL 만 리허설 DB 로 (환경 변수가 .env.local 보다 앞선다).
  # 계측 · 알림 키는 비워 운영 지표에 섞이지 않게 한다.
  ( cd "$APP" && exec sudo -u arcade env NODE_ENV=production DATABASE_URL="$R_URL" PORT=$PORT_R \
      METRICS_TOKEN= PULSE_URL= PULSE_TOKEN= OPS_ALERT_TOKEN= \
      node node_modules/next/dist/bin/next start -p $PORT_R ) > "$WORK.app.log" 2>&1 &
  APP_PID=$!
  ok=""
  for _ in $(seq 1 60); do
    sleep 1
    if curl -fsS -m 3 "http://127.0.0.1:$PORT_R/api/health" >/dev/null 2>&1; then ok=1; break; fi
  done
  T_APP=$(secs "$t0")
  if [[ -z "$ok" ]]; then
    APP_OK="✗ 60초 안에 안 뜸"; echo "$APP_OK — 앱 로그 끝:"; tail -20 "$WORK.app.log"
  else
    echo "✔ 기동 ${T_APP}초"
    APP_OK="ok"
    probe() { # $1 이름 · $2 경로 · $3 jq 대신 쓸 grep 패턴
      local code; code=$(curl -s -o "$WORK.body" -w '%{http_code}' -m 20 "http://127.0.0.1:$PORT_R$2")
      if [[ "$code" == "200" ]] && grep -q "$3" "$WORK.body"; then printf '  ✔ %-12s %s  %s\n' "$1" "$code" "$2"
      else printf '  ✗ %-12s %s  %s\n' "$1" "$code" "$2"; APP_OK="✗ 일부 실패"; fi
    }
    probe health   "/api/health"              '"status":"healthy"\|"status":"degraded"'
    probe 오락실   "/api/arcades"             '"arcades":\[{'
    probe 글목록   "/api/posts?limit=5"       '"posts":'
    probe 서열표   "/api/tier"                '"games":'
    probe 첫화면   "/"                        '<html'
    rm -f "$WORK.body"
    # 운영과 복원본은 내용이 같아 응답만으로는 어느 DB 를 봤는지 모른다 — 리허설 DB 에 접속이 붙었는지 본다
    conns=$(sudo -u postgres psql -Atqc "SELECT count(*) FROM pg_stat_activity WHERE datname='$RDB'")
    if (( conns > 0 )); then echo "  ✔ 앱이 리허설 DB($RDB)에 붙어 있음 — 접속 ${conns}개"
    else echo "  ✗ 리허설 DB 에 접속이 없음 — 앱이 다른 DB 를 봤습니다"; APP_OK="✗ 다른 DB"; fi
  fi
  kill "$APP_PID" 2>/dev/null || true; sleep 1; pkill -f "next start -p $PORT_R" 2>/dev/null || true; APP_PID=""
fi
rm -f "$WORK.app.log"

step "결과"
cat <<EOF
  DB 복원        ${T_DB}초   (표 ${TABLES}개 · 복원본에 없는 표 ${MISSING}개)
  첨부 풀기      ${T_UPL}초   (빠진 첨부 ${UPL_MISSING}개)
  앱 기동        ${T_APP}초   (${APP_OK})
  ── 실제 복구라면 여기에 서비스 정지 · DB 이름 교체 · 첨부 교체 · 서비스 시작(약 30초)이 더해집니다 (README §4 의 4단계)
  기록: $LOG
EOF
