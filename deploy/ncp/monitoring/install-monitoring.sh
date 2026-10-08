#!/usr/bin/env bash
# 실서버 감시 — 지표를 긁어 Grafana Cloud 로 보낸다. 그래프 · 알림은 Grafana Cloud 에서 본다 (README §9).
#
#   sudo bash /srv/arcade-finder/app/arcade-finder/deploy/ncp/monitoring/install-monitoring.sh /root/grafana-cloud.env
#   sudo bash …/install-monitoring.sh                 # 이미 설치된 서버를 새 판으로 — 접속 정보는 서버에 있는 설정을 다시 쓴다
#   sudo bash …/install-monitoring.sh --remove        # 감시만 끄고 지운다 (앱 · DB · 지표 토큰은 그대로)
#
# 배포 묶음 안의 것을 그 자리에서 돌린다 — 옆의 설정 · 서비스 파일을 같이 쓰기 때문이다.
# 여러 번 돌려도 된다(이미 된 것은 건너뛰고, 설정은 새 판으로 덮는다).
#
# 하는 일
#   1. Prometheus(agent 모드) · node_exporter · postgres_exporter 를 GitHub 릴리스에서 받아 sha256 을 맞춰 본다
#   2. 전용 사용자 arcade-monitor 와 설정 폴더 /etc/arcade-monitoring (비밀 파일은 root · arcade-monitor 만 읽음)
#   3. 앱 지표 토큰(METRICS_TOKEN) · 운영 알림 웹훅 토큰(OPS_ALERT_TOKEN) · 웹 푸시 키(OPS_PUSH_*)를
#      **서버에서** 만든다 — PC 의 값은 서버로 오지 않는다(make-server-env.sh)
#   4. PostgreSQL 감시 계정 arcade_monitor (pg_monitor 역할 · 접속 3개까지 · 통계를 읽기만)
#   5. Caddyfile 을 묶음의 새 판으로 — Caddy 지표를 켜고 /api/metrics 를 밖에서 막는다
#   6. systemd 서비스 셋. 전부 127.0.0.1 에만 열고 메모리 상한을 건다 (1GB 서버)
#      + 프로세스 이름별 메모리를 1분마다 재는 timer (node_exporter 의 textfile 수집기로 나간다)
#   7. 토큰을 새로 넣었을 때만 앱을 다시 띄운다 — 10~20초 끊긴다
#   8. Grafana Cloud 가 첫 지표를 받았는지 확인한다
#
# 알림 규칙(rules.yml)은 여기서 올리지 않는다 — Grafana Cloud 화면에서 Grafana 관리 규칙으로 한 번 가져온다(README §9-4).
# 처음에는 mimirtool 로 Prometheus(Mimir)에 올렸는데, 그 규칙의 알림은 Grafana 의 연락 지점으로 오지 않았다(2026-10-06).
set -Eeuo pipefail
# set -e 는 멈출 때 아무 말도 하지 않는다. 어느 줄의 무슨 명령에서 멈췄는지 반드시 남긴다 (bootstrap.sh 와 같은 이유)
trap 'rc=$?; [[ $BASH_SUBSHELL -eq 0 ]] && echo "✗ install-monitoring.sh ${LINENO}번째 줄에서 멈췄습니다 (종료 코드 $rc): $BASH_COMMAND" >&2' ERR

PROM_VER=3.15.0
NODE_VER=1.12.1
PGEXP_VER=0.20.1

ROOT=/srv/arcade-finder
APP="$ROOT/app/arcade-finder"
HERE="$(cd "$(dirname "$0")" && pwd)"
ETC=/etc/arcade-monitoring
OPT=/opt/arcade-monitoring
DATA=/var/lib/arcade-monitoring
UNITS=(arcade-prometheus-agent arcade-node-exporter arcade-postgres-exporter)
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then echo "root 로 돌려 주세요: sudo bash $0 /root/grafana-cloud.env" >&2; exit 2; fi

if [[ "${1:-}" == "--remove" ]]; then
  step "감시 끄고 지우기"
  for u in "${UNITS[@]}"; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$u.service"
  done
  systemctl disable --now arcade-process-memory.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/arcade-process-memory.service /etc/systemd/system/arcade-process-memory.timer
  systemctl daemon-reload
  rm -rf "$OPT" "$DATA" "$ETC"
  sudo -u postgres psql -qc "DROP ROLE IF EXISTS arcade_monitor" || true
  echo "✔ 서비스 셋 · 바이너리 · 설정 · DB 감시 계정을 지웠습니다."
  echo "  남긴 것: 앱 .env.local 의 METRICS_TOKEN(/api/metrics 는 Caddy 가 막음) · Caddy 지표 설정 · 사용자 arcade-monitor"
  exit 0
fi

CLOUD_ENV="${1:-}"
if [[ -n "$CLOUD_ENV" ]]; then
  [[ -f "$CLOUD_ENV" ]] || { echo "없음: $CLOUD_ENV — PC 에서 scp 로 올렸는지, 경로가 맞는지 보세요" >&2; exit 2; }
  # source 하지 않는다 — 토큰에 셸이 읽는 글자가 있어도 그대로 받으려고. 따옴표 · CR 은 떼어 낸다
  get() {
    local v
    v="$( { tr -d '\r' < "$CLOUD_ENV" | grep -E "^$1=" || true; } | tail -n 1 | cut -d= -f2-)"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    printf '%s' "$v"
  }
  PUSH_URL="$(get GRAFANA_CLOUD_PROM_URL)"
  PUSH_USER="$(get GRAFANA_CLOUD_PROM_USER)"
  PUSH_TOKEN="$(get GRAFANA_CLOUD_TOKEN)"
  SRC="$CLOUD_ENV"
elif [[ -f "$ETC/prometheus.yml" && -s "$ETC/grafana-cloud-token" ]]; then
  # 이미 설치된 서버 — 설치 뒤 grafana-cloud.env 는 지웠을 것이므로, 지금 설정에서 접속 정보를 꺼내 다시 쓴다
  PUSH_URL="$(sed -nE "s/^[[:space:]]*- url: '(.*)'\$/\1/p" "$ETC/prometheus.yml" | awk 'NR == 1')"
  PUSH_USER="$(sed -nE "s/^[[:space:]]*username: '(.*)'\$/\1/p" "$ETC/prometheus.yml" | awk 'NR == 1')"
  PUSH_TOKEN="$(cat "$ETC/grafana-cloud-token")"
  SRC="$ETC (지금 설치된 설정)"
  echo "접속 정보: $SRC 의 것을 다시 씁니다"
else
  echo "Grafana Cloud 접속 정보 파일을 주세요: sudo bash $0 /root/grafana-cloud.env" >&2
  echo "  PC 의 deploy/ncp/monitoring/grafana-cloud.env.example 을 deploy/ncp/grafana-cloud.env 로 복사해 채우고 scp 로 올립니다 (README §9)" >&2
  exit 2
fi

missing=()
[[ "$PUSH_URL" =~ ^https?:// ]] || missing+=("GRAFANA_CLOUD_PROM_URL (https:// 로 시작하는 Remote Write Endpoint)")
[[ -n "$PUSH_USER" ]] || missing+=("GRAFANA_CLOUD_PROM_USER (숫자 Instance ID)")
[[ -n "$PUSH_TOKEN" ]] || missing+=("GRAFANA_CLOUD_TOKEN (glc_ 로 시작하는 토큰)")
if (( ${#missing[@]} )); then
  echo "$SRC 에 비었거나 틀린 값이 있습니다:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 2
fi
[[ "$PUSH_URL" == */api/prom/push ]] || echo "⚠ GRAFANA_CLOUD_PROM_URL 이 /api/prom/push 로 끝나지 않습니다 — Grafana Cloud 의 Remote Write Endpoint 를 그대로 넣었는지 보세요" >&2

# 앱이 먼저 깔려 있어야 한다 — 토큰을 넣을 .env.local 과, 다시 띄울 서비스가 필요하다
[[ -f "$APP/.env.local" ]] || { echo "$APP/.env.local 이 없습니다 — bootstrap.sh · install-release.sh 를 먼저 돌리세요" >&2; exit 2; }
systemctl cat arcade-finder >/dev/null 2>&1 || { echo "arcade-finder 서비스가 없습니다 — install-release.sh 를 먼저 돌리세요" >&2; exit 2; }
command -v caddy >/dev/null || { echo "Caddy 가 없습니다 — bootstrap.sh 를 먼저 돌리세요" >&2; exit 2; }
[[ "$(uname -m)" == "x86_64" ]] || { echo "x86_64 서버만 됩니다 (지금: $(uname -m))" >&2; exit 2; }
for f in prometheus-agent.yml "${UNITS[@]/%/.service}" process-memory.sh arcade-process-memory.service arcade-process-memory.timer; do
  [[ -f "$HERE/$f" ]] || { echo "$HERE/$f 가 없습니다 — 배포 묶음 안의 install-monitoring.sh 를 그 자리에서 돌려 주세요" >&2; exit 2; }
done
FREE_MB="$(df -Pm / | awk 'NR == 2 {print $4}')"
(( FREE_MB > 600 )) || { echo "디스크가 모자랍니다 — 남은 ${FREE_MB}MB, 600MB 는 있어야 합니다 (다 쓴 배포 묶음부터 지우세요)" >&2; exit 2; }

step "1. 바이너리 (sha256 확인)"
install -d -m 755 "$OPT" "$OPT/bin"
# get_release <이름> <버전> <저장소> <꺼낼 실행 파일…> — 같은 버전이 이미 있으면 받지 않는다
get_release() {
  local name="$1" ver="$2" repo="$3"; shift 3
  local dir="$OPT/$name-$ver" tgz="$name-$ver.linux-amd64.tar.gz" tmp b
  if [[ -x "$dir/$1" ]]; then
    echo "  $name $ver — 이미 있음"
  else
    tmp="$(mktemp -d)"
    curl -fsSL --retry 3 --max-time 300 -o "$tmp/$tgz" "https://github.com/$repo/releases/download/v$ver/$tgz"
    curl -fsSL --retry 3 --max-time 60 -o "$tmp/sha256sums.txt" "https://github.com/$repo/releases/download/v$ver/sha256sums.txt"
    if ! ( cd "$tmp" && grep -E "  $tgz\$" sha256sums.txt | sha256sum -c --quiet - ); then
      echo "✗ $tgz 의 sha256 이 릴리스 목록과 다릅니다 — 받다가 깨졌거나 바뀐 파일입니다. 설치하지 않습니다" >&2
      rm -rf "$tmp"; exit 1
    fi
    tar -xzf "$tmp/$tgz" -C "$tmp"
    install -d -m 755 "$dir"
    for b in "$@"; do install -m 755 "$tmp/$name-$ver.linux-amd64/$b" "$dir/$b"; done
    rm -rf "$tmp"
    echo "  $name $ver — 받음 (sha256 일치)"
  fi
  for b in "$@"; do ln -sfn "$dir/$b" "$OPT/bin/$b"; done
}
get_release prometheus "$PROM_VER" prometheus/prometheus prometheus promtool
get_release node_exporter "$NODE_VER" prometheus/node_exporter node_exporter
get_release postgres_exporter "$PGEXP_VER" prometheus-community/postgres_exporter postgres_exporter
# 옛 버전 폴더는 지운다 — 10GB 디스크 (예전 판이 받던 mimirtool 도 여기서 정리된다)
find "$OPT" -mindepth 1 -maxdepth 1 -type d ! -name bin \
  ! -name "prometheus-$PROM_VER" ! -name "node_exporter-$NODE_VER" ! -name "postgres_exporter-$PGEXP_VER" \
  -exec rm -rf {} +

step "2. 사용자 · 설정 폴더"
id arcade-monitor >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin arcade-monitor
install -d -m 750 -o root -g arcade-monitor "$ETC"
install -d -m 750 -o arcade-monitor -g arcade-monitor "$DATA"
# 프로세스별 메모리를 root 가 쓰고 node_exporter(arcade-monitor)가 읽는다 — setgid 라 새 파일도 그룹이 arcade-monitor
install -d -m 2750 -o root -g arcade-monitor "$DATA/textfile"
# write_secret <파일> <값> — root 가 쓰고 arcade-monitor 가 읽는다. 끝에 줄바꿈을 붙이지 않는다
write_secret() { ( umask 027; printf '%s' "$2" > "$1" ); chgrp arcade-monitor "$1"; chmod 640 "$1"; }
write_secret "$ETC/grafana-cloud-token" "$PUSH_TOKEN"

step "3. 앱 쪽 비밀 값 (METRICS_TOKEN · 운영 알림 토큰 · 푸시 키)"
METRICS_TOKEN="$( { grep -E '^METRICS_TOKEN=' "$APP/.env.local" || true; } | tail -n 1 | cut -d= -f2-)"
TOKEN_ADDED=0
if [[ -z "$METRICS_TOKEN" ]]; then
  METRICS_TOKEN="$(openssl rand -hex 32)"
  cp -p "$APP/.env.local" "$APP/.env.local.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# ── install-monitoring.sh 가 만든 값 (%s) — 서버의 수집기가 /api/metrics 를 긁을 때 쓴다 ──\nMETRICS_TOKEN=%s\n' \
    "$(date +%F)" "$METRICS_TOKEN" >> "$APP/.env.local"
  TOKEN_ADDED=1
  echo "새로 만들어 .env.local 에 넣었습니다 (앱은 7단계에서 다시 띄웁니다)"
else
  echo "이미 있음 — 그대로 씁니다"
fi
write_secret "$ETC/metrics-token" "$METRICS_TOKEN"

# 운영 알림 (관리자 화면의 종 아이콘 · 기기 알림 — components/OpsAlertBell.tsx).
#   OPS_ALERT_TOKEN       Grafana 알림 웹훅(POST /api/ops/alerts)이 들고 오는 토큰 — 9-4 에서 Grafana 연락 지점에 넣는다
#   OPS_PUSH_*_KEY        웹 푸시(VAPID) 키 쌍 — 브라우저 푸시 서버에 우리가 보낸 것임을 서명한다
# 이미 있으면 그대로 둔다. 바꾸면 Grafana 연락 지점을 고치고 기기마다 알림을 다시 켜야 한다.
if ! grep -qE '^OPS_ALERT_TOKEN=.' "$APP/.env.local"; then
  (( TOKEN_ADDED )) || cp -p "$APP/.env.local" "$APP/.env.local.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# ── install-monitoring.sh 가 만든 값 (%s) — Grafana 알림 웹훅이 이 토큰으로 들어온다 (README §9-4) ──\nOPS_ALERT_TOKEN=%s\n' \
    "$(date +%F)" "$(openssl rand -hex 32)" >> "$APP/.env.local"
  TOKEN_ADDED=1
  echo "운영 알림 토큰(OPS_ALERT_TOKEN)을 만들어 넣었습니다"
fi
if ! grep -qE '^OPS_PUSH_PRIVATE_KEY=.' "$APP/.env.local"; then
  (( TOKEN_ADDED )) || cp -p "$APP/.env.local" "$APP/.env.local.bak-$(date +%Y%m%d%H%M%S)"
  # P-256 키 쌍 — 공개 키는 압축하지 않은 65바이트, 비밀 키는 32바이트(앞자리가 0 이면 짧게 나오므로 채운다)를 base64url 로.
  # web-push 는 길이가 다르면 거절한다. Node 는 bootstrap.sh 가 깔아 둔 것을 쓴다
  # shellcheck disable=SC2016
  vapid="$(node -e '
    const e = require("node:crypto").createECDH("prime256v1"); e.generateKeys();
    const d = e.getPrivateKey(); const priv = Buffer.concat([Buffer.alloc(32 - d.length), d]);
    process.stdout.write(e.getPublicKey().toString("base64url") + " " + priv.toString("base64url"));')"
  printf '# 관리자 기기 알림(웹 푸시)의 VAPID 키 쌍 — 바꾸면 기기마다 알림을 다시 켜야 한다\nOPS_PUSH_PUBLIC_KEY=%s\nOPS_PUSH_PRIVATE_KEY=%s\n' \
    "${vapid%% *}" "${vapid##* }" >> "$APP/.env.local"
  TOKEN_ADDED=1
  echo "웹 푸시 키(OPS_PUSH_PUBLIC_KEY · OPS_PUSH_PRIVATE_KEY)를 만들어 넣었습니다"
fi

step "4. PostgreSQL 감시 계정 (arcade_monitor)"
PG_ENV="$ETC/postgres-exporter.env"
role_exists="$(sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='arcade_monitor'")"
if [[ "$role_exists" == "1" && -f "$PG_ENV" ]]; then
  echo "이미 있음"
else
  PG_PW="$(openssl rand -hex 24)"
  if [[ "$role_exists" == "1" ]]; then
    sudo -u postgres psql -qc "ALTER ROLE arcade_monitor LOGIN PASSWORD '$PG_PW' CONNECTION LIMIT 3"
  else
    sudo -u postgres psql -qc "CREATE ROLE arcade_monitor LOGIN PASSWORD '$PG_PW' CONNECTION LIMIT 3"
  fi
  # pg_monitor: 통계 뷰를 읽는 내장 역할. 테이블의 데이터는 읽지 못한다
  sudo -u postgres psql -qc "GRANT pg_monitor TO arcade_monitor"
  write_secret "$PG_ENV" "DATA_SOURCE_NAME=postgresql://arcade_monitor:${PG_PW}@127.0.0.1:5432/arcade_finder?sslmode=disable"
  echo "만들었습니다 (비밀번호는 $PG_ENV)"
fi

step "5. Caddy — 지표 켜기 · /api/metrics 막기"
SITE_DOMAIN="$( { grep -E '^APP_URL=' "$APP/.env.local" || true; } | tail -n 1 | cut -d= -f2- | tr -d '"'"'" | sed -E 's#^https?://##; s#/.*$##')"
[[ -n "$SITE_DOMAIN" ]] || { echo ".env.local 에 APP_URL 이 없어 Caddy 주소를 알 수 없습니다" >&2; exit 2; }
sed "s/__SITE_DOMAIN__/${SITE_DOMAIN}/g" "$HERE/../Caddyfile" > /etc/caddy/Caddyfile.new
chmod 644 /etc/caddy/Caddyfile.new
if cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  rm -f /etc/caddy/Caddyfile.new
  echo "이미 새 판 ($SITE_DOMAIN)"
else
  # 검사는 caddy 사용자로 — root 로 돌리면 /root 아래에 Caddy 데이터 폴더가 생긴다
  if ! sudo -u caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/tmp/caddy-validate.log 2>&1; then
    echo "✗ 새 Caddyfile 이 검사를 통과하지 못해 바꾸지 않았습니다:" >&2
    tail -n 5 /tmp/caddy-validate.log >&2
    rm -f /etc/caddy/Caddyfile.new; exit 1
  fi
  cp -p /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "바꿨습니다 ($SITE_DOMAIN · 옛 판은 /etc/caddy/Caddyfile.bak-*)"
fi

step "6. 수집기 설정 · 서비스"
# 앱 인스턴스 수 — bootstrap.sh 가 작은 서버에 넣은 drop-in(INSTANCES=1)까지 합친 값. 뒤에 나온 것이 이긴다
INSTANCES="$(systemctl show arcade-finder -p Environment --value | tr ' ' '\n' | sed -n 's/^INSTANCES=//p' | tail -n 1)"
INSTANCES="${INSTANCES:-2}"
targets="$(for i in $(seq 0 $(( INSTANCES - 1 ))); do printf "'127.0.0.1:%d', " $(( 3001 + i )); done)"
targets="${targets%, }"
# sed 치환 문자열에서 뜻이 있는 글자(& | \)를 막는다
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
sed -e "s|__APP_TARGETS__|$(esc "$targets")|" \
    -e "s|__PUSH_URL__|$(esc "$PUSH_URL")|" \
    -e "s|__PUSH_USER__|$(esc "$PUSH_USER")|" \
    "$HERE/prometheus-agent.yml" > "$ETC/prometheus.yml"
chgrp arcade-monitor "$ETC/prometheus.yml"; chmod 640 "$ETC/prometheus.yml"
"$OPT/bin/promtool" check config --agent "$ETC/prometheus.yml" >/dev/null
echo "앱 대상: $targets (인스턴스 $INSTANCES개)"
for u in "${UNITS[@]}"; do install -m 644 "$HERE/$u.service" "/etc/systemd/system/$u.service"; done
install -m 755 "$HERE/process-memory.sh" "$OPT/bin/process-memory"
install -m 644 "$HERE/arcade-process-memory.service" "$HERE/arcade-process-memory.timer" /etc/systemd/system/
systemctl daemon-reload
# 프로세스별 메모리는 node_exporter 가 처음 긁을 때부터 값이 있게 한 번 먼저 잰다
systemctl start arcade-process-memory.service \
  || { echo "✗ 프로세스별 메모리를 재지 못했습니다:" >&2; journalctl -u arcade-process-memory -n 20 --no-pager >&2; exit 1; }
systemctl enable --now arcade-process-memory.timer >/dev/null 2>&1
for u in "${UNITS[@]}"; do systemctl enable "$u" >/dev/null 2>&1; systemctl restart "$u"; done
sleep 3
for u in "${UNITS[@]}"; do
  systemctl is-active --quiet "$u" || { echo "✗ $u 가 뜨지 않았습니다:" >&2; journalctl -u "$u" -n 20 --no-pager >&2; exit 1; }
done
echo "셋 다 떴습니다"

if (( TOKEN_ADDED )); then
  step "7. 앱 다시 띄우기 (METRICS_TOKEN 을 읽게) — 10~20초 끊깁니다"
  systemctl restart arcade-finder
  for i in $(seq 1 45); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)"
    [[ "$code" == "200" ]] && { echo "✔ /api/health 200 (${i}×2초)"; break; }
    sleep 2
  done
  [[ "${code:-}" == "200" ]] || { echo "✗ 앱이 90초 안에 뜨지 않았습니다:" >&2; journalctl -u arcade-finder -n 30 --no-pager >&2; exit 1; }
else
  step "7. 앱 다시 띄우기 — 건너뜀 (토큰이 이미 있었음)"
fi

step "8. 확인"
first="$(cut -d"'" -f2 <<<"$targets")"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $METRICS_TOKEN" "http://$first/api/metrics" || true)"
echo "  앱 /api/metrics (안에서, 토큰)    $code   — 200 이어야 함"
code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$SITE_DOMAIN:443:127.0.0.1" "https://$SITE_DOMAIN/api/metrics" || true)"
echo "  https://$SITE_DOMAIN/api/metrics   $code   — 404 여야 함 (Caddy 가 막음)"
for t in 9100 9187 2019; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$t/metrics" || true)"
  echo "  127.0.0.1:$t/metrics             $code"
done
n="$(curl -s http://127.0.0.1:9100/metrics | grep -c '^arcade_process_memory_bytes{' || true)"
echo "  프로세스별 메모리 시계열           $n개 — 0 이면 node_exporter 가 textfile 을 못 읽음"
# 운영 알림 웹훅 — 토큰 없이 부르면 401 이어야 켜진 것이다 (404 면 앱이 OPS_ALERT_TOKEN 을 못 읽음). 알림은 만들지 않는다
code="$(curl -sk -o /dev/null -w '%{http_code}' -X POST --resolve "$SITE_DOMAIN:443:127.0.0.1" "https://$SITE_DOMAIN/api/ops/alerts" || true)"
echo "  https://$SITE_DOMAIN/api/ops/alerts $code   — 401 이어야 함 (운영 알림 웹훅이 켜져 있고 토큰을 요구함)"

# agent 는 60초마다 긁고 몇 초 안에 보낸다. 보낸 표본 수 · 실패 수는 agent 자신의 지표에 있다
# 라벨이 붙어 나온다(name{remote_name=…,url=…} 값) — 이름으로 시작하는 줄을 모두 더한다
counter() { curl -s http://127.0.0.1:9090/metrics | awk -v n="$1" '$1 == n || index($1, n "{") == 1 {s += $NF} END {print int(s)}'; }
echo "  Grafana Cloud 로 첫 전송을 기다립니다 (최대 2분)…"
sent=0; failed=0
for i in $(seq 1 24); do
  sent="$(counter prometheus_remote_storage_samples_total)"
  failed="$(counter prometheus_remote_storage_samples_failed_total)"
  (( sent > 0 || failed > 0 )) && break
  sleep 5
done
# samples_total 은 보내려 한 수다 — 거절당한 것도 들어간다. 받았는지는 실패가 0 인지로 본다
if (( sent > 0 && failed == 0 )); then
  echo "✔ Grafana Cloud 가 받았습니다 — 표본 ${sent}개"
else
  echo "✗ 보내지 못했습니다 (시도 ${sent} · 실패 ${failed}). 401/403 이면 토큰 · Instance ID, 404 면 URL 을 보세요:" >&2
  journalctl -u arcade-prometheus-agent -n 50 --no-pager | grep -E 'level=(ERROR|WARN)' | tail -n 3 | sed -E 's/.*(msg=)/  \1/' >&2 || true
  exit 1
fi

step "끝 — 메모리"
# postgresql.service 는 껍데기다 — 실제 서버는 postgresql@18-main
for u in "${UNITS[@]}" arcade-finder postgresql@18-main caddy; do
  m="$(systemctl show "$u" -p MemoryCurrent --value 2>/dev/null || true)"
  [[ "$m" =~ ^[0-9]+$ ]] && printf '  %-28s %4d MB\n' "$u" $(( m / 1048576 ))
done
free -m | awk 'NR<=3'
cat <<EOF

다음 (Grafana Cloud 화면에서, 처음 한 번 — README §9-4):
  · Dashboards → New → Import → PC 의 monitoring/grafana/dashboards/arcade-finder.json
    (대시보드가 바뀐 판이면 같은 파일을 다시 Import 해서 덮어씁니다 — uid 가 같다)
  · Alerting → Notification configuration → Contact points 에 알림 받을 메일
  · Alerting → Alert rules → More → Import alert rules → Prometheus YAML file 에 PC 의 deploy/ncp/monitoring/rules.yml
    (데이터 소스 grafanacloud-…-prom · 폴더 arcade-finder · "Pause imported alerting rules" 끄기)
  · 운영 알림(관리자 화면의 종 아이콘 · 기기 알림): Contact points 의 empty 에 Webhook 통합을 더합니다
      URL           https://$SITE_DOMAIN/api/ops/alerts
      Authorization Scheme Bearer · Credentials 는 아래 명령으로 본 값 (이 화면에 찍지 않습니다)
                    grep '^OPS_ALERT_TOKEN=' $APP/.env.local
EOF
if [[ -n "$CLOUD_ENV" ]]; then echo "  · 올린 grafana-cloud.env 는 지우세요: rm $CLOUD_ENV"; fi
