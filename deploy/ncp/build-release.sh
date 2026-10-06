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

# 묶음 이름에 붙일 커밋. ⚠ 주 체크아웃의 arcade-finder/ 에는 옛 중첩 저장소(.git)가 따로 있어서,
# 그냥 `git -C "$APP_DIR"` 로 물으면 바깥 저장소가 아니라 그쪽 커밋이 나온다. 바깥에도 저장소가
# 있으면 바깥을 본다 (워크트리 · GitHub 클론처럼 하나뿐이면 그대로).
REPO="$APP_DIR"
if [[ -e "$APP_DIR/.git" ]] && git -C "$APP_DIR/.." rev-parse --git-dir >/dev/null 2>&1; then REPO="$APP_DIR/.."; fi
REV="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo nogit)"
# 커밋 안 된 수정이 앱 폴더 안에 있으면 표시한다 (추적하지 않는 새 파일은 세지 않는다)
DIRTY="$(git -C "$REPO" status --porcelain --untracked-files=no -- "$(cd "$APP_DIR" && pwd)" 2>/dev/null | head -1 || true)"
[[ -n "$DIRTY" ]] && REV="$REV-dirty"
NAME="release-$(date +%Y%m%d-%H%M)-$REV.tgz"
mkdir -p "$OUT_DIR"

# Git Bash 가 /src 같은 인자를 C:/Program Files/Git/src 로 바꾸지 않게
export MSYS_NO_PATHCONV=1
to_host() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

# 이 PC 가 가진 비밀 값 목록 — 묶음 소스에 이 값이 그대로 들어 있으면 컨테이너 안에서 빌드를 멈춘다.
# 파일 이름 검사(.env* · *.env)는 견본(.example)에 실제 토큰을 붙여 넣은 경우를 못 잡는다 — 2026-10-06 에
# grafana-cloud.env.example 에 Grafana Cloud 토큰이 들어간 채로 빌드될 뻔했다. 네이버 · 카카오 비밀처럼
# 정해진 모양이 없는 값도 이렇게 실제 값과 견주어야 잡힌다. 값은 화면에 찍지 않고, 끝나면 지운다.
SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT
chmod 600 "$SECRETS_FILE"
for f in "$APP_DIR/.env.local" "$HERE/server.env" "$HERE/grafana-cloud.env"; do
  [[ -f "$f" ]] || continue
  # 이름이 …SECRET · KEY · TOKEN · PASSWORD 로 끝나는 키와 DATABASE_URL. NEXT_PUBLIC_* 은 원래 공개되는 값이다.
  # 12자보다 짧은 값은 흔한 낱말과 겹칠 수 있어 뺀다
  tr -d '\r' < "$f" | grep -E '^[A-Z][A-Z0-9_]*(SECRET|KEY|TOKEN|PASSWORD)=|^DATABASE_URL=' | grep -v '^NEXT_PUBLIC_' \
    | cut -d= -f2- | sed -E "s/^[\"']|[\"']\$//g" | awk 'length >= 12' >> "$SECRETS_FILE" || true
done

echo "▶ $IMAGE 에서 빌드 → $NAME"
docker run --rm --platform linux/amd64 \
  -v "$(to_host "$APP_DIR"):/src:ro" \
  -v "$(to_host "$OUT_DIR"):/out" \
  -v "$(to_host "$SECRETS_FILE"):/secrets.txt:ro" \
  --env-file "$(to_host "$BUILD_ENV")" \
  -e NAME="$NAME" -e DB_FALLBACK=off -e NEXT_TELEMETRY_DISABLED=1 \
  "$IMAGE" bash -euo pipefail -c '
    mkdir /app
    # ./uploads 처럼 **앞에 ./ 를 붙여** 최상위만 거른다. 그냥 uploads 로 적으면
    # app/api/uploads(라우트)까지 빠진다 — 2026-09 에 동기화 · 파일 세기에서 실제로 당했다.
    # ./.claude · ./.next-* : 주 체크아웃에만 있는 옛 워크트리(그 안의 .env.local 까지)와 옛 빌드 사본.
    #   2026-09-29 묶음이 이것 때문에 557MB 가 됐고 개발용 .env.local 사본이 실렸다.
    # .env.local · .env.*.local 은 ./ 없이 — 어느 깊이에 있든 뺀다.
    # ./monitoring : 로컬 Prometheus · Grafana. 서버에서 쓰지 않고, monitoring/.env 에 개발 DB 비밀번호가 있다.
    tar -C /src -cf - \
      --exclude=./node_modules --exclude=./.next --exclude="./.next-*" --exclude=./uploads \
      --exclude=./.env --exclude=.env.local --exclude=".env.*.local" --exclude=./.claude \
      --exclude=./lib/generated --exclude=./backups --exclude=./.pglite \
      --exclude=./.git --exclude=./coverage --exclude=./logs --exclude=./localdata \
      --exclude=./.arcade-import-state.json --exclude=./tsconfig.tsbuildinfo \
      --exclude=./deploy/ncp/out --exclude=./deploy/ncp/build.env --exclude=./deploy/ncp/server.env \
      --exclude=./deploy/ncp/grafana-cloud.env --exclude=./monitoring \
      . | tar -C /app -xf -
    cd /app
    # 위 목록에서 빠진 게 있어도 비밀이 서버로 가지 않게 — .env.example 말고 .env* · *.env(server.env · grafana-cloud.env 꼴)
    # · 키 파일 · .claude 가 보이면 멈춘다
    leak="$(find . -path ./node_modules -prune -o -name ".env*" ! -name ".env.example" -print -o -name "*.env" -print -o -name "*.pem" -print -o -name .claude -print | awk "NR <= 5")"   # head 는 find 를 SIGPIPE 로 끊어 pipefail 에 걸린다
    if [ -n "$leak" ]; then echo "✗ 묶음에 들어가면 안 되는 파일이 있어 멈춥니다 (build-release.sh 의 --exclude 에 더하세요):"; echo "$leak"; exit 1; fi
    # 이름이 아니라 **내용** — 알려진 토큰 모양(Grafana Cloud · Google · Pulse · AWS · GitHub · 개인 키)과 이 PC 의
    # 실제 비밀 값(/secrets.txt, 위에서 모음). 걸린 파일 이름만 찍는다. 각 grep 뒤의 || true 는 "못 찾음"(종료 코드 1)이
    # set -e 로 묶음 검사 자체를 끝내지 않게
    pat="glc_[A-Za-z0-9+/=_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|pk_[a-f0-9]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    hit="$( { grep -rIlE "$pat" . || true; if [ -s /secrets.txt ]; then grep -rIlFf /secrets.txt . || true; fi; } | sort -u | awk "NR <= 5")"
    if [ -n "$hit" ]; then echo "✗ 비밀 값(토큰 · 키)이 든 파일이 있어 멈춥니다 — 값은 찍지 않습니다. 견본(.example) · 문서에 실제 값을 붙여 넣지 않았는지 보세요:"; echo "$hit"; exit 1; fi
    npm ci --no-audit --no-fund --loglevel=error     # postinstall 이 prisma generate 까지 한다
    npm run build
    rm -rf .next/cache .pglite
    echo "$NAME" > RELEASE
    tar -czf "/out/$NAME" .
  '

echo "✔ $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1))"
# NCP 의 .pem 은 SSH 키가 아니라 콘솔에서 root 비밀번호를 푸는 키다 — scp -i 로 주면 거절된다
echo "  올리기: scp \"$OUT_DIR/$NAME\" root@<공인IP>:/root/   (root 비밀번호로 접속 · 첫 설치면 server.env 도 함께)"
