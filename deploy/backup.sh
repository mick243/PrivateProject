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
KEEP_DAYS="${KEEP_DAYS:-14}"
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
    tar --zstd -cf "$BACKUP_DIR/uploads-$STAMP.tar.zst" -C "$APP_DIR" uploads
  else
    tar -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" -C "$APP_DIR" uploads
  fi
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
