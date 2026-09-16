# 운영 — 배포 · 마이그레이션 · 백업 · 복구

> 2026-09-13 작성. 대상: Linux 한 대(systemd) + PostgreSQL 18 + 이 앱 인스턴스 2개.
> 근거는 [docs/QA-LAUNCH-READINESS.md](../docs/QA-LAUNCH-READINESS.md) B1~B3 —
> 그 전까지 이 저장소에는 **운영 DB 에 마이그레이션을 비파괴로 넣는 도구도, 프로세스
> 관리자도, 백업 절차도 없었습니다.**

## 0. 한 장 요약

| 하려는 일 | 명령 |
|---|---|
| 처음 설치 | 아래 §1 |
| 코드 배포 (무중단) | `git pull && npm ci && npm run build && npm run db:migrate && systemctl reload arcade-finder` |
| 스키마만 미리 적용 | `npm run db:migrate` (`-- --dry-run` 으로 미리보기) |
| 백업 | `deploy/backup.sh` (systemd timer 가 매일 04:00) |
| 복구 | §4 |
| 상태 | `curl -s localhost:3000/api/health` · `journalctl -u arcade-finder -f` |

**절대 하지 말 것**: 운영 `.env` 가 있는 디렉터리에서 `npm run db:init` / `db:reset`. 테이블을
DROP 합니다. 개발 DB 를 그렇게 한 번 날렸습니다(2026-08-24).

## 1. 처음 설치

```bash
# 앱 사용자와 디렉터리
sudo useradd --system --home /srv/arcade-finder --shell /usr/sbin/nologin arcade
sudo mkdir -p /srv/arcade-finder /var/backups/arcade-finder
sudo chown -R arcade:arcade /srv/arcade-finder /var/backups/arcade-finder

# 코드
sudo -u arcade git clone <repo> /srv/arcade-finder/app
cd /srv/arcade-finder/app/arcade-finder
sudo -u arcade npm ci

# 환경 — .env.example 을 복사해 채웁니다. 운영 필수값이 빠지면 서버가 뜨지 않습니다
# (lib/env-check.ts — 어떤 값이 왜 필요한지 로그에 나옵니다)
sudo -u arcade cp .env.example .env.local && sudo -u arcade nano .env.local
```

`.env.local` 에서 **운영 필수**:

| 키 | 값 |
|---|---|
| `NODE_ENV` | (systemd unit 이 production 을 넣습니다) |
| `DATABASE_URL` | `postgresql://arcade:***@localhost:5432/arcade_finder` |
| `AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_PASSWORD` | 관리자 비밀번호 (기본값 없음) |
| `APP_URL` | `https://<운영 도메인>` — OAuth 콜백·sitemap·OG 의 기준 |
| `TRUSTED_PROXY_HOPS` | `1` (start:cluster 만) · nginx 를 앞에 두면 `2` |
| `NEXT_PUBLIC_NAVER_MAP_KEY_ID` | 빌드 시점 값 — 바꾸면 **재빌드** |
| `NEXT_PUBLIC_OPERATOR_NAME` · `NEXT_PUBLIC_CONTACT_EMAIL` | 약관·처리방침에 찍히는 운영자 정보 (없으면 화면에 경고가 보입니다) |

DB 와 첫 스키마:

```bash
sudo -u postgres createuser arcade --pwprompt
sudo -u postgres createdb -O arcade arcade_finder
# 개발 DB 의 실데이터(오락실 939 · 채보 5,157)를 가져가는 경우:
pg_restore -w -d "$DATABASE_URL" --no-owner dev.dump
# 또는 빈 DB 에서 시작하는 경우 (시드의 '(가상)' 오락실 5곳이 들어갑니다 — 지우세요):
npm run db:migrate
```

빌드와 서비스 등록:

```bash
sudo -u arcade npm run build
sudo cp deploy/arcade-finder.service /etc/systemd/system/
sudo cp deploy/arcade-finder-backup.service deploy/arcade-finder-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arcade-finder arcade-finder-backup.timer
curl -s localhost:3000/api/health
```

앞에 TLS 종단(nginx·caddy)을 두고 3000 으로 프록시하세요. 내부 포트 3001·3002 는
루프백에만 바인딩됩니다(`scripts/start-cluster.mjs`).

## 2. 배포 (무중단)

```bash
cd /srv/arcade-finder/app && sudo -u arcade git pull
cd arcade-finder
sudo -u arcade npm ci
sudo -u arcade npm run build
sudo -u arcade npm run db:migrate          # 새 마이그레이션이 있으면 여기서 미리 적용
sudo systemctl reload arcade-finder        # SIGHUP → 인스턴스를 하나씩 교체
```

`reload` 는 인스턴스 하나를 프록시에서 빼고 → 끄고 → 새 코드로 띄우고 → `/api/health`
200 을 확인한 뒤 다음으로 넘어갑니다. 그동안 다른 인스턴스가 트래픽을 받습니다.
90초 안에 돌아오지 않으면 교체를 멈추고 나머지는 옛 코드로 계속 돕니다(로그 확인).

`db:migrate` 를 빼먹어도 첫 인스턴스가 뜰 때 advisory lock 안에서 적용합니다 — 다만
그 인스턴스의 첫 응답이 늦어지고, 실패하면 그 인스턴스가 뜨지 않습니다. 미리 하는
쪽이 낫습니다.

⚠ **`migrate-057`(token_epoch)을 올리는 배포에서는 로그인한 사람이 전부 로그아웃됩니다.**
세션 토큰의 모양이 바뀌어서, 그 전에 나간 쿠키는 세대 번호가 없어 무효가 됩니다. 사고가
아니라 의도입니다(회수 수단이 생긴 것) — 다만 **한 번뿐이고**, 다음 배포부터는 그렇지
않습니다. 출시 전이면 신경 쓸 일이 아니고, 이미 사용자가 있다면 공지하고 한적한 시간에
하세요. 순서를 반대로(코드 먼저, 마이그레이션 나중) 하면 `token_epoch` 이 없어 **모든
로그인이 500 으로 깨집니다.**

## 3. 백업

`deploy/backup.sh` 가 매일 04:00(timer) 다음을 `/var/backups/arcade-finder/` 에 둡니다:

- `db-<날짜>.dump` — `pg_dump -Fc` (176MB 급 DB 가 30MB 대로 압축됩니다)
- `uploads-<날짜>.tar.zst` — 첨부 원본(`uploads/posts/`). **DB 밖 파일**이라 덤프에 없습니다
- 14일 지난 것은 지웁니다 (`KEEP_DAYS`)

다른 장비로 복사하지 않으면 백업이 아닙니다 — 스크립트 끝의 `OFFSITE` 훅에 rclone/scp
한 줄을 넣으세요.

## 4. 복구 (리허설 포함)

**출시 전에 한 번 실제로 해 보세요.** 되는지 모르는 백업은 없는 것과 같습니다.

```bash
# 1. 새 DB 로 복원 (운영 DB 는 건드리지 않고)
sudo -u postgres createdb -O arcade arcade_finder_restore
pg_restore -w -d "postgresql://arcade:***@localhost/arcade_finder_restore" --no-owner /var/backups/arcade-finder/db-YYYYMMDD.dump

# 2. 첨부
mkdir -p /tmp/restore && tar --zstd -xf /var/backups/arcade-finder/uploads-YYYYMMDD.tar.zst -C /tmp/restore

# 3. 그 DB 로 앱을 띄워 로그인·목록·글 상세가 열리는지 (다른 포트)
DATABASE_URL=postgresql://arcade:***@localhost/arcade_finder_restore PORT=3900 INSTANCE_PORT_BASE=3901 \
  npm run start:cluster
curl -s localhost:3900/api/health

# 4. 실제 복구라면: 서비스 정지 → 운영 DB 이름 교체 → uploads 교체 → 서비스 시작
sudo systemctl stop arcade-finder
sudo -u postgres psql -c "ALTER DATABASE arcade_finder RENAME TO arcade_finder_broken; ALTER DATABASE arcade_finder_restore RENAME TO arcade_finder;"
rsync -a --delete /tmp/restore/uploads/ /srv/arcade-finder/app/arcade-finder/uploads/
sudo systemctl start arcade-finder
```

RPO 는 하루(백업 주기)입니다. 더 줄이려면 timer 를 `*:00/6` 같은 식으로 좁히세요 —
덤프는 30초 안에 끝납니다.

## 5. 출시 체크리스트

- [ ] `.env.local` 운영 필수 8개 채움 → `npm run build && NODE_ENV=production node -e "require('./.next/server/app/api/health/route.js')"` 대신 그냥 서비스를 띄워 `journalctl` 에 `[env] ✗` 가 없는지 확인
- [ ] NCP 콘솔 Maps > Web 서비스 URL 에 **운영 도메인** 등록 (안 하면 FallbackMap 으로 뜹니다 — 이제 조용히 실패하지 않고 그리로 갑니다)
- [ ] Google·카카오·네이버 콘솔에 `https://<도메인>/api/auth/oauth/<provider>/callback` 등록, 카카오·네이버 심사에 `/privacy` URL 제출
- [ ] `/terms` · `/privacy` 에 자리표시자 경고가 안 보이는지
- [ ] 히스토리에 노출됐던 키(`83fb7d6`: Gemini 키 · 지도 키 ID) 재발급 확인
- [ ] `npm run db:purge-demo` — 시드 글·가상 오락실 확인 후 `-- --apply`
- [ ] `npm run arcades:dedupe` — 중복 오락실 확인 후 `-- --apply`
- [ ] 복구 리허설 1회 (§4)
- [ ] CI 초록 (`.github/workflows/ci.yml`)
- [ ] `curl -I https://<도메인>/robots.txt` · `/sitemap.xml` · `/opengraph-image` 200
- [ ] **지도 키를 넣은 뒤 브라우저 콘솔에 CSP 위반이 없는지** — 네이버 지도 SDK 는 로컬에 키가 없어 검증하지 못했습니다. 막히면 `next.config.mjs` 의 `script-src`·`connect-src`·`img-src` 에 그 도메인을 더하세요
