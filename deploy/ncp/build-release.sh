#!/usr/bin/env bash
# PC 에서 리눅스(x86_64)용 배포 묶음을 만든다 — Docker Desktop 이 떠 있어야 한다.
#
#   bash deploy/ncp/build-release.sh          → deploy/ncp/out/release-<시각>-<커밋>.tgz
#
# 왜 서버에서 빌드하지 않나: `next build` 가 이 앱에서 메모리를 3GB 넘게 쓴다(2026-09-29 실측
# 3.2GB · 42초). Micro 서버는 1GB 라 스왑을 써도 몇십 분 걸리거나 죽는다. 그래서 빌드는 PC 의
# 리눅스 컨테이너에서 하고, 서버는 풀기만 한다. 컨테이너에서 npm ci 까지 하므로 node_modules 의
# 네이티브 바이너리(sharp 등)도 리눅스용으로 들어간다.
#
# 묶음에 들어가지 않는 것: node_modules 안의 캐시 · .next/cache · uploads/ · .env.local ·
#   백업 · .pglite · 로컬 데이터. 비밀은 하나도 들어가지 않는다 — 운영 값은 server.env 로 따로 간다.
# 빌드 때 필요한 공개 값(지도 키 ID · APP_URL · 운영자 정보)은 deploy/ncp/build.env 에서 읽는다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$HERE/out"
BUILD_ENV="$HERE/build.env"
IMAGE="${IMAGE:-node:24-bookworm}"

if [[ ! -f "$BUILD_ENV" ]]; then
  echo "deploy/ncp/build.env 가 없습니다 — build.env.example 을 복사해 채우세요" >&2
  exit 2
fi
docker info >/dev/null 2>&1 || { echo "Docker 가 꺼져 있습니다 — Docker Desktop 을 켜 주세요" >&2; exit 2; }

REV="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY="$(git -C "$APP_DIR" status --porcelain -- . 2>/dev/null | grep -v '^?? deploy/ncp/' | head -1 || true)"
[[ -n "$DIRTY" ]] && REV="$REV-dirty"
NAME="release-$(date +%Y%m%d-%H%M)-$REV.tgz"
mkdir -p "$OUT_DIR"

# Git Bash 가 /src 같은 인자를 C:/Program Files/Git/src 로 바꾸지 않게
export MSYS_NO_PATHCONV=1
to_host() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

echo "▶ $IMAGE 에서 빌드 → $NAME"
docker run --rm --platform linux/amd64 \
  -v "$(to_host "$APP_DIR"):/src:ro" \
  -v "$(to_host "$OUT_DIR"):/out" \
  --env-file "$(to_host "$BUILD_ENV")" \
  -e NAME="$NAME" -e DB_FALLBACK=off -e NEXT_TELEMETRY_DISABLED=1 \
  "$IMAGE" bash -euo pipefail -c '
    mkdir /app
    # ./uploads 처럼 **앞에 ./ 를 붙여** 최상위만 거른다. 그냥 uploads 로 적으면
    # app/api/uploads(라우트)까지 빠진다 — 2026-09 에 동기화 · 파일 세기에서 실제로 당했다.
    tar -C /src -cf - \
      --exclude=./node_modules --exclude=./.next --exclude=./uploads --exclude=./.env.local \
      --exclude=./.env --exclude=./lib/generated --exclude=./backups --exclude=./.pglite \
      --exclude=./.git --exclude=./coverage --exclude=./logs --exclude=./localdata \
      --exclude=./deploy/ncp/out --exclude=./deploy/ncp/build.env --exclude=./deploy/ncp/server.env \
      . | tar -C /app -xf -
    cd /app
    npm ci --no-audit --no-fund --loglevel=error     # postinstall 이 prisma generate 까지 한다
    npm run build
    rm -rf .next/cache .pglite
    echo "$NAME" > RELEASE
    tar -czf "/out/$NAME" .
  '

echo "✔ $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1))"
echo "  올리기: scp -i <키.pem> \"$OUT_DIR/$NAME\" root@<공인IP>:/root/"
