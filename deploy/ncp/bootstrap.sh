#!/usr/bin/env bash
# 네이버 클라우드 서버 한 대를 오락실 파인더가 돌 수 있는 상태로 만든다 — **한 번만** 돌리면 된다.
#
#   sudo SITE_DOMAIN=223-130-1-2.sslip.io bash bootstrap.sh
#
# 하는 일 (여러 번 돌려도 이미 된 것은 건너뛴다):
#   1. 메모리가 작으면 스왑 2GB   2. 시간대 Asia/Seoul
#   3. Node 24 · PostgreSQL 18 · Caddy 설치
#   4. PostgreSQL 을 서버 메모리에 맞게 조이고, arcade 계정 · arcade_finder DB 를 만든다
#   5. 앱 사용자(arcade)와 디렉터리 · 운영 비밀 3개(DB 비밀번호 · AUTH_SECRET · ADMIN_PASSWORD)
#   6. Caddy 가 SITE_DOMAIN 으로 HTTPS 인증서를 받아 3000 으로 넘기게
#
# 앱 코드는 여기서 받지 않는다 — PC 에서 만든 배포 묶음을 install-release.sh 로 넣는다 (README.md).
# 대상: Ubuntu 22.04 · 24.04 (x86_64). 네이버 클라우드 Micro(1GB)부터 동작하게 맞췄다.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "root 로 돌려 주세요: sudo SITE_DOMAIN=… bash $0" >&2; exit 2; fi
if [[ -z "${SITE_DOMAIN:-}" ]]; then
  ip="$(curl -4 -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
  echo "SITE_DOMAIN 이 없습니다. 공인 IP 로 만든 무료 주소를 쓰려면:" >&2
  [[ -n "$ip" ]] && echo "  sudo SITE_DOMAIN=${ip//./-}.sslip.io bash $0" >&2
  exit 2
fi

ROOT=/srv/arcade-finder
APP="$ROOT/app/arcade-finder"
SECRETS=/root/arcade-finder-secrets.env
# MEM_MB 를 주면 그 값으로 본다 — 컨테이너에서 리허설할 때 /proc/meminfo 가 호스트 메모리를 보여 주기 때문
MEM_MB="${MEM_MB:-$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))}"
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

step "1. 스왑 (메모리 ${MEM_MB}MB)"
# Micro(1GB) 에서는 Node + PostgreSQL + 빌드 없는 운영만으로도 빠듯하다. 디스크 10GB 를 생각해 2GB 만.
if (( MEM_MB < 3000 )) && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/90-arcade-swap.conf
else
  echo "건너뜀 (메모리가 넉넉하거나 스왑이 이미 있음)"
fi

step "2. 시간대 · 기본 도구"
timedatectl set-timezone Asia/Seoul || true
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg zstd rsync openssl debian-keyring debian-archive-keyring apt-transport-https >/dev/null
# 커널은 올리지 않는다 — NCP 는 "Ubuntu 커널 업데이트는 지원하지 않으며, 업데이트한 서버의 복구도 지원하지
# 않는다" 고 안내한다(서버 요금 페이지). 자동 보안 업데이트(unattended-upgrades)가 커널을 올리지 못하게 고정한다.
KERNEL_PKGS="$(dpkg-query -W -f='${Package} ${Status}\n' 'linux-image-*' 'linux-headers-*' 'linux-modules-*' 'linux-generic*' 'linux-virtual*' 2>/dev/null | awk '/ installed$/ {print $1}')"
[[ -n "$KERNEL_PKGS" ]] && apt-mark hold $KERNEL_PKGS >/dev/null && echo "커널 패키지 $(wc -w <<<"$KERNEL_PKGS")개 고정"

step "3-1. Node 24"
if ! node -v 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

step "3-2. PostgreSQL 18"
if ! command -v /usr/lib/postgresql/18/bin/postgres >/dev/null; then
  apt-get install -y -qq postgresql-common >/dev/null
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  apt-get install -y -qq postgresql-18 >/dev/null
fi
# 메모리의 1/8 을 공유 버퍼로 (1GB → 128MB). 연결은 앱 풀(PG_POOL_MAX) × 인스턴스 + 여유면 충분하다
SB=$(( MEM_MB / 8 )); (( SB < 64 )) && SB=64
cat > /etc/postgresql/18/main/conf.d/arcade-finder.conf <<EOF
# bootstrap.sh 가 만든 값 — 서버 메모리 ${MEM_MB}MB 기준
max_connections = 40
shared_buffers = ${SB}MB
effective_cache_size = $(( MEM_MB / 2 ))MB
work_mem = 4MB
maintenance_work_mem = 32MB
timezone = 'Asia/Seoul'
EOF
systemctl restart postgresql

step "4. DB 계정 · 운영 비밀"
if [[ ! -f "$SECRETS" ]]; then
  # umask 는 이 파일에만 — 밖에 새면 뒤에서 만드는 apt 키 · Caddyfile 까지 root 전용이 되어 못 읽는다
  ( umask 077; cat > "$SECRETS" <<EOF
DB_PASSWORD=$(openssl rand -hex 24)
AUTH_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
EOF
  )
fi
# shellcheck disable=SC1090
source "$SECRETS"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='arcade'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE arcade LOGIN PASSWORD '$DB_PASSWORD'"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='arcade_finder'" | grep -q 1 \
  || sudo -u postgres createdb -O arcade -E UTF8 -T template0 arcade_finder

step "5. 앱 사용자 · 디렉터리"
id arcade >/dev/null 2>&1 || useradd --system --home "$ROOT" --shell /usr/sbin/nologin arcade
# .pglite 는 비어 있어도 있어야 한다 — systemd unit 의 ReadWritePaths 가 없는 경로면 서비스가 안 뜬다
mkdir -p "$APP/uploads" "$APP/.pglite" "$ROOT/releases" /var/backups/arcade-finder
chown -R arcade:arcade "$ROOT" /var/backups/arcade-finder

# 서버가 만드는 값만 먼저 채운다. 나머지(지도 · 로그인 · AI 키)는 PC 에서 만든 server.env 를
# install-release.sh 가 합친다 (README.md 3단계).
if [[ ! -f "$APP/.env.local" ]]; then
  install -o arcade -g arcade -m 600 /dev/null "$APP/.env.local"
  cat > "$APP/.env.local" <<EOF
# ── bootstrap.sh 가 만든 값 ($(date +%F)) ──
DATABASE_URL=postgresql://arcade:${DB_PASSWORD}@localhost:5432/arcade_finder
AUTH_SECRET=${AUTH_SECRET}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
APP_URL=https://${SITE_DOMAIN}
# Caddy(1) + start-cluster 의 프록시(1)
TRUSTED_PROXY_HOPS=2
DB_FALLBACK=off
EOF
fi

step "6. Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
sed "s/__SITE_DOMAIN__/${SITE_DOMAIN}/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

# 서버가 스스로 쓰는 메모리 상한 — 인스턴스 수와 힙을 메모리에 맞춘다 (install-release.sh 가 unit 을 넣은 뒤 먹는다)
mkdir -p /etc/systemd/system/arcade-finder.service.d
if (( MEM_MB < 3000 )); then
  cat > /etc/systemd/system/arcade-finder.service.d/ncp.conf <<'EOF'
# bootstrap.sh — 작은 서버(Micro 1GB)용. 인스턴스 1개 · 힙 384MB · 풀 5
[Service]
Environment=INSTANCES=1
Environment=PG_POOL_MAX=5
Environment=NODE_OPTIONS=--max-old-space-size=384
EOF
else
  cat > /etc/systemd/system/arcade-finder.service.d/ncp.conf <<'EOF'
# bootstrap.sh — 메모리 3GB 이상. deploy/arcade-finder.service 기본값(인스턴스 2개)을 그대로 쓴다
[Service]
EOF
fi

cat <<EOF

✔ 준비 끝 — https://${SITE_DOMAIN}
  관리자 비밀번호 · DB 비밀번호는 ${SECRETS} 에 있습니다 (root 만 읽음).
  다음: PC 에서 만든 배포 묶음과 server.env 를 올리고
        sudo bash install-release.sh release-….tgz server.env
EOF
