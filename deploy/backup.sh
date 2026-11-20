#!/usr/bin/env bash
# DB 덤프 + 첨부 아카이브. systemd timer(arcade-finder-backup.timer)가 매일 부릅니다.
#
#   deploy/backup.sh                 .env.local 의 DATABASE_URL 로 덤프
#   BACKUP_DIR=/mnt/bk deploy/backup.sh
#
# 복구는 deploy/README.md §4. **출시 전에 한 번 실제로 복구해 보세요.**
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/arcade-finder}"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# .env.local 에서 DATABASE_URL 만 (다른 값은 건드리지 않음)
if [[ -z "${DATABASE_URL:-}" && -f "$APP_DIR/.env.local" ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env.local" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL 이 없습니다" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

# 1. DB — custom 형식(-Fc)은 압축되고 pg_restore 로 테이블 단위 복구가 됩니다
pg_dump -w -Fc --no-owner --dbname="$DATABASE_URL" --file="$BACKUP_DIR/db-$STAMP.dump.tmp"
mv "$BACKUP_DIR/db-$STAMP.dump.tmp" "$BACKUP_DIR/db-$STAMP.dump"

# 2. 첨부 — DB 밖 파일 (lib/uploads.ts). 없으면 건너뜁니다
if [[ -d "$APP_DIR/uploads" ]]; then
  if command -v zstd >/dev/null; then
    out="$BACKUP_DIR/uploads-$STAMP.tar.zst"
    tar --zstd -cf "$out" -C "$APP_DIR" uploads
  else
    out="$BACKUP_DIR/uploads-$STAMP.tar.gz"
    tar -czf "$out" -C "$APP_DIR" uploads
  fi
  # 첨부가 그대로면 날마다 같은 묶음이 하나씩 쌓인다 — 베타 서버에서 41MB 짜리 15개가 크기까지 똑같았다(2026-10-16).
  # 오늘 것과 같은 옛 묶음은 지운다. 같은 상태를 오늘 것이 담고 있으니 되살릴 수 있는 시점은 줄지 않고,
  # 남는 쪽이 가장 새것이라 3. 의 보존 기간 정리에도 먼저 걸리지 않는다
  for old in "$BACKUP_DIR"/uploads-*.tar.*; do
    if [[ "$old" != "$out" ]] && cmp -s "$old" "$out"; then rm -f "$old"; fi
  done
fi

# 3. 보존 기간 밖은 정리
find "$BACKUP_DIR" -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.*' \) -mtime "+$KEEP_DAYS" -delete

# 4. 다른 장비로 — 여기 한 줄을 채우지 않으면 같은 디스크 안의 사본일 뿐입니다
#    예: rclone copy "$BACKUP_DIR" remote:arcade-finder-backups --max-age 2d
#    예: rsync -a "$BACKUP_DIR/" backup-host:/srv/arcade-finder-backups/
if [[ -n "${OFFSITE:-}" ]]; then
  eval "$OFFSITE"
fi

echo "✔ $STAMP — $(du -sh "$BACKUP_DIR" | cut -f1) in $BACKUP_DIR"
