#!/usr/bin/env bash
# 배포 전 DB 점검 — install-release.sh 가 **서비스를 멈추기 전에** 부른다. DB 에는 읽기만 한다.
#
#   bash predeploy-check.sh <DATABASE_URL> <묶음의 prisma/migrations 폴더>
#
# 종료 코드
#   0  배포해도 된다. 마지막 줄에 `PENDING=<적용할 마이그레이션 수>` 를 찍는다
#   3  기준점(베이스라인)이 없다 — 표는 있는데 _prisma_migrations 가 없다. 이대로 migrate deploy 를 돌리면
#      P3005("데이터베이스가 비어 있지 않다")로 멈추고, 서비스는 이미 내려가 있다
#   4  끝나지 않은 마이그레이션이 있다 — 지난 배포에서 실패한 것. migrate deploy 가 P3009 로 멈춘다
#   2  DB 에 붙지 못했거나 인자가 잘못됐다
#
# ─── 왜 따로 두나 (2026-11-20 마이그레이션 회의) ──────────────────────────
# install-release.sh 는 서비스를 멈추고(3단계) 코드를 바꾼 뒤에야 마이그레이션을 돌렸다(5단계). 그래서
# 위 두 경우가 생기면 **멈춘 서비스를 둔 채** 스크립트가 끝났다. 둘 다 DB 를 한 번 읽으면 미리 알 수 있는
# 일이라, 멈추기 전에 여기서 거른다. 따로 둔 것은 서버 없이(로컬 PostgreSQL 로) 시험하기 위해서다.
set -Eeuo pipefail

if (( $# != 2 )); then echo "사용: $0 <DATABASE_URL> <migrations 폴더>" >&2; exit 2; fi
DB_URL="$1"
MIG_DIR="$2"
[[ -d "$MIG_DIR" ]] || { echo "마이그레이션 폴더가 없습니다: $MIG_DIR" >&2; exit 2; }

# tr -d '\r' — Windows 의 psql 은 줄 끝에 CR 을 붙여, 이름 대조가 전부 어긋났다(로컬 시험에서 실제로 걸림)
q() { psql -w -X -q -At "$DB_URL" -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
q "SELECT 1" >/dev/null 2>&1 || { echo "✗ DB 에 붙지 못했습니다 — .env.local 의 DATABASE_URL 과 PostgreSQL 이 떠 있는지 보세요" >&2; exit 2; }

has_tables="$(q "SELECT to_regclass('public.arcades') IS NOT NULL")"
has_ledger="$(q "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")"

# 묶음에 든 마이그레이션 (폴더 이름 = Prisma 의 migration_name)
mapfile -t bundled < <(find "$MIG_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)

if [[ "$has_tables" != "t" ]]; then
  echo "빈 DB 입니다 — 첫 설치. 마이그레이션 ${#bundled[@]}개를 처음부터 적용합니다."
  echo "PENDING=${#bundled[@]}"
  exit 0
fi

if [[ "$has_ledger" != "t" ]]; then
  cat >&2 <<EOF
✗ 이 DB 에는 표가 있는데 Prisma 이력(_prisma_migrations)이 없습니다 — 기준점(베이스라인)이 안 잡혀 있습니다.
  이대로 migrate deploy 를 돌리면 P3005 로 멈춥니다. 서비스는 멈추지 않았습니다(지금 그대로 돌고 있습니다).
  해결 — 지금 앱 폴더에서 미리 보고, 맞으면 표시합니다 (DDL 은 실행하지 않고 이력 표에 "이미 됨" 만 적습니다):
    cd /srv/arcade-finder/app/arcade-finder
    sudo -u arcade -H npm run db:prisma:baseline -- --dry-run
    sudo -u arcade -H npm run db:prisma:baseline
  그다음 이 설치를 다시 돌리세요. 자세한 것: deploy/README.md 「배포가 멈췄을 때」
EOF
  exit 3
fi

unfinished="$(q "SELECT string_agg(migration_name, ' ') FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")"
if [[ -n "$unfinished" ]]; then
  cat >&2 <<EOF
✗ 끝나지 않은 마이그레이션이 있습니다 (지난 배포에서 실패): $unfinished
  이대로 migrate deploy 를 돌리면 P3009 로 멈춥니다. 서비스는 멈추지 않았습니다.
  해결 — 그 마이그레이션이 DB 에 반쯤 남긴 것이 있는지 먼저 보고(배포 직전 덤프와 비교),
    · 되돌렸으면:   sudo -u arcade -H npx prisma migrate resolve --rolled-back <이름>
    · 손으로 끝냈으면: sudo -u arcade -H npx prisma migrate resolve --applied <이름>
  (앱 폴더 /srv/arcade-finder/app/arcade-finder 에서). 자세한 것: deploy/README.md 「배포가 멈췄을 때」
EOF
  exit 4
fi

mapfile -t applied < <(q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1")
pending=()
for m in "${bundled[@]}"; do
  printf '%s\n' "${applied[@]}" | grep -qxF "$m" || pending+=("$m")
done
# DB 에는 있는데 묶음에는 없는 것 — 옛 묶음으로 되돌리는 중이다. 막지는 않는다(코드 되돌리기는 정당한 일이다)
newer=()
for m in "${applied[@]}"; do
  printf '%s\n' "${bundled[@]}" | grep -qxF "$m" || newer+=("$m")
done

echo "적용된 마이그레이션 ${#applied[@]}개 · 이번에 적용할 것 ${#pending[@]}개"
for m in "${pending[@]}"; do echo "  + $m"; done
if (( ${#newer[@]} > 0 )); then
  echo "⚠ DB 가 이 묶음보다 새 마이그레이션 ${#newer[@]}개를 갖고 있습니다 — 옛 묶음으로 되돌리는 중이라면 정상입니다." >&2
  echo "  마이그레이션은 되돌리지 않으므로, 옛 코드가 새 스키마에서 도는지 확인하세요: ${newer[*]}" >&2
fi
echo "PENDING=${#pending[@]}"
