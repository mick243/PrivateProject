#!/usr/bin/env bash
# PC 의 .env.local 에서 **서버로 가져갈 키만** 골라 deploy/ncp/server.env 를 만든다.
#
#   bash deploy/ncp/make-server-env.sh [원본 .env.local]     (기본: 이 앱 폴더의 .env.local)
#
# 가져가지 않는 것 — 서버가 따로 만들거나(bootstrap.sh), 로컬에서만 뜻이 있는 값:
#   DATABASE_URL · AUTH_SECRET · ADMIN_PASSWORD · APP_URL · TRUSTED_PROXY_HOPS · DB_FALLBACK
#   PG_CONNECT_TIMEOUT_MS · PULSE_*(로컬 계측 서버) · NODE_ENV
#   METRICS_*(PC 의 값은 로컬 Prometheus 용 — 서버 토큰은 monitoring/install-monitoring.sh 가 서버에서 만든다)
# server.env 에는 API 비밀이 들어간다. 커밋되지 않게 .gitignore 에 올려 두었고,
# 서버에 올린 뒤에는 PC 쪽 사본을 지우세요.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../../.env.local}"
OUT="$HERE/server.env"
[[ -f "$SRC" ]] || { echo "원본이 없습니다: $SRC" >&2; exit 2; }

SKIP='^(DATABASE_URL|AUTH_SECRET|ADMIN_PASSWORD|APP_URL|TRUSTED_PROXY_HOPS|DB_FALLBACK|PG_CONNECT_TIMEOUT_MS|NODE_ENV|PULSE_[A-Z_]*|METRICS_[A-Z_]*)='
umask 077
{
  echo "# make-server-env.sh 가 $(date +%F) 에 만든 값 — install-release.sh 가 서버 .env.local 에 합친다"
  # 주석 · 빈 줄 · 서버가 만드는 키를 빼고, Windows 줄바꿈(CR)을 떼어 낸다
  tr -d '\r' < "$SRC" | grep -E '^[A-Z][A-Z0-9_]*=' | grep -Ev "$SKIP" || true
} > "$OUT"

echo "✔ $OUT — 키 $(grep -cE '^[A-Z]' "$OUT")개:"
grep -oE '^[A-Z][A-Z0-9_]*' "$OUT" | tr '\n' ' '; echo
echo "  (값은 출력하지 않았습니다)"
