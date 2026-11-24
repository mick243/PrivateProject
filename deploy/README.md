# 운영 — 배포 · 마이그레이션 · 백업 · 복구

> 2026-09-13 작성. 대상: Linux 한 대(systemd) + PostgreSQL 18 + 이 앱 인스턴스 2개.
> 근거는 [docs/QA-LAUNCH-READINESS.md](../docs/QA-LAUNCH-READINESS.md) B1~B3 —
> 그 전까지 이 저장소에는 **운영 DB 에 마이그레이션을 비파괴로 넣는 도구도, 프로세스
> 관리자도, 백업 절차도 없었습니다.**

## 0. 한 장 요약

| 하려는 일 | 명령 |
|---|---|
| 처음 설치 | 아래 §1 |
| 코드 배포 (재기동만 무중단 — §2) | `git pull && npm ci && npm run build && npm run db:migrate:prisma && systemctl reload arcade-finder` |
| 스키마만 미리 적용 | `npm run db:migrate:prisma` (= `prisma migrate deploy`; 상태는 `npx prisma migrate status`) |
| 기존 DB 를 Prisma 이력에 처음 얹기 (한 번) | `npm run db:prisma:baseline -- --dry-run` → `npm run db:prisma:baseline` |
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
| `NEXT_PUBLIC_OPERATOR_NAME` · `NEXT_PUBLIC_CONTACT_EMAIL` | 약관·처리방침에 찍히는 운영자 정보 — **빌드 때** 박힘. 비면 build-release.sh 가 멈추고, 그렇게 만든 빌드는 기동 검사(lib/env-check.ts)가 막음. 개발 모드에서만 화면에 설정 안내가 보임 |

DB 와 첫 데이터 (자세한 이유와 실측은 docs/DATA-SOURCES.md):

```bash
sudo -u postgres createuser arcade --pwprompt
sudo -u postgres createdb -O arcade arcade_finder
npm run db:migrate:prisma                     # 스키마 + 기준 데이터 (prisma/migrations 전부)
npm run db:views                              # 뷰 2개 (앱이 뜰 때도 만들어지지만 먼저 확인하려면)
npm run db:purge-demo -- --apply              # 시드가 넣은 가상 오락실 8곳 · 시드 글 30개 치우기
# 외부 원천 데이터(오락실 · maimai/CHUNITHM 곡·채보) — 개발 장비에서 export 한 폴더를 옮겨 와서:
#   (개발 장비)  npm run data:release -- export   → backups/data-release/<시각>/
npm run data:release -- import <폴더> --write
npm run data:release -- verify <폴더>          # 없음 0 · 다름 0 이어야 합니다
```

- 예전에는 개발 DB 를 통째로 `pg_restore` 했습니다. 그러면 개발하며 만든 계정·글·투표까지 운영으로 가서 쓰지
  않습니다. 릴리스는 사용자 데이터를 담지 않습니다. 릴리스 폴더는 **커밋하지 마세요**(네이버 검색 결과 포함).
- 시드의 가상 투표자 12명과 그 투표 77표는 purge-demo 뒤에도 남습니다. 일부가 실제 서열표 배치를 떠받치고
  있어서입니다(docs/DATA-SOURCES.md §2).
- 백업 덤프로 **복구**하는 경우(아래 백업 절)는 그대로 `pg_restore` 입니다. 복원한 DB 에는 이력을 얹어야 앱이
  "미적용" 경고를 찍지 않습니다: `npm run db:prisma:baseline`.

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

## 2. 배포

```bash
cd /srv/arcade-finder/app && sudo -u arcade git pull
cd arcade-finder
sudo -u arcade npm ci
sudo -u arcade npm run build
sudo -u arcade npm run db:migrate:prisma   # 새 마이그레이션이 있으면 **반드시** 여기서 적용
sudo systemctl reload arcade-finder        # SIGHUP → 인스턴스를 하나씩 교체
journalctl -u arcade-finder -f             # "교체 끝" 줄이 나오면 끝
```

`reload` 는 인스턴스 하나를 프록시에서 빼고 → 그 인스턴스로 간 요청이 끝나길 기다리고(최대 30초) →
끄고 → 새 코드로 띄우고 → `/api/health` 200 을 확인한 뒤 다음으로 넘어갑니다
(`scripts/start-cluster.mjs` 의 `rollingRestart`). 그동안 다른 인스턴스가 트래픽을 받습니다.
90초 안에 돌아오지 않으면 교체를 멈추고 나머지는 옛 코드로 계속 돕니다(로그에 `✗ … 교체를 멈춥니다`).
교체 도중 reload 가 또 오면 끝난 뒤 한 바퀴 더 돕니다.

- **`systemctl reload` 는 신호만 보내고 바로 돌아옵니다** — 저널의 `Reloaded` 도 교체 전에 찍힙니다.
  끝났는지는 `교체 끝` 줄로 보세요. 인스턴스 2개면 2초 안팎입니다.
- **무중단은 인스턴스가 2개 이상일 때만입니다.** NCP Micro(1GB)는 `deploy/ncp/bootstrap.sh` 의 drop-in 이
  `INSTANCES=1` 로 두므로, reload 해도 새 인스턴스가 준비될 때까지 프록시가 503(+Retry-After)을
  돌려줍니다. restart 보다 짧을 뿐 0 은 아닙니다. NCP 재배포는 어차피 `install-release.sh` 가
  stop → 교체 → start 합니다.
- **같은 디렉터리에서 `npm ci` · `npm run build` 를 하는 동안은 무중단이 아닙니다.** `next build` 는
  시작하자마자 `.next/` 를 비우고 다시 쓰는데, 옛 인스턴스는 거기서 정적 파일(`/_next/static/…`)을
  읽습니다. 그 사이 그 요청은 500 입니다. 코드가 바뀌었다면 빌드가 끝난 뒤 reload 전까지 옛 HTML 이
  가리키는 청크 이름이 없어져 404 가 됩니다. `npm ci` 도 `node_modules` 를 지웠다 다시 깝니다(이쪽은
  미측정). 끊김 없는 배포까지 가려면 다른 디렉터리에서 빌드한 뒤 갈아 끼우는 방식이 필요한데, 아직 없습니다.

실측 (2026-10-06 · 이 PC 의 Docker. Ubuntu 24.04 + systemd 255 컨테이너에 이 unit 을 그대로 넣고
`/api/health` · `/` · `/finder` 를 동시 4개로 쉬지 않고 요청):

| | reload 동안 실패 | 비고 |
|---|---|---|
| 고치기 전 (SIGHUP 처리 없음) · 인스턴스 2 | **5.5초** (연결 거부 3.2초 → 503 2.2초) | 런처가 죽고 `Restart=always` 가 RestartSec=3 뒤 다시 띄움 · NRestarts 1 |
| 지금 · 인스턴스 2 | **0건** / 15,560 | MainPID 그대로 · 교체 1.6초 |
| 지금 · 인스턴스 1 | **0.7초** 동안 503 | 1 vCPU 서버에서는 더 깁니다(미측정) |
| 지금 · 인스턴스 2 · 같은 디렉터리에서 빌드 → reload | 빌드 중 정적 청크 500 **1.0초**(658건) · reload 중 0건 | 캐시가 따뜻한 4초짜리 빌드 — 처음 빌드면 훨씬 깁니다 |

⚠ **`db:migrate:prisma` 는 빼먹으면 안 됩니다.** 2026-09-22 부터 앱은 기동하면서 마이그레이션을
적용하지 않습니다(Prisma — lib/prisma.ts). 빠진 것이 있으면 기동 로그에 경고가 찍히고, 새
컬럼을 읽는 코드는 그 자리에서 500 이 됩니다. 예전처럼 "첫 인스턴스가 대신 적용" 하는 일은
없습니다. 뷰(`db/views.sql`)만 기동마다 앱이 다시 만듭니다.

⚠ **`migrate-057`(token_epoch)을 올리는 배포에서는 로그인한 사람이 전부 로그아웃됩니다.**
세션 토큰의 모양이 바뀌어서, 그 전에 나간 쿠키는 세대 번호가 없어 무효가 됩니다. 사고가
아니라 의도입니다(회수 수단이 생긴 것). 다만 **한 번뿐이고**, 다음 배포부터는 그렇지
않습니다. 출시 전이면 신경 쓸 일이 아니고, 이미 사용자가 있다면 공지하고 한적한 시간에
하세요. 순서를 반대로(코드 먼저, 마이그레이션 나중) 하면 `token_epoch` 이 없어 **모든
로그인이 500 으로 깨집니다.**

## 2-1. 배포가 멈췄을 때 (2026-11-20)

`install-release.sh` 는 **서비스를 멈추기 전에** DB 를 점검합니다(`deploy/ncp/predeploy-check.sh`, 읽기만 함).
아래 셋 중 앞의 둘은 서비스가 그대로 도는 채로 멈추므로 서두를 필요가 없습니다.

| 멈춘 자리 | 뜻 | 할 일 |
|---|---|---|
| 3단계 · 코드 3 | 표는 있는데 `_prisma_migrations` 가 없다 — 기준점(베이스라인)이 없다. 그대로 deploy 하면 P3005 | 앱 폴더에서 `sudo -u arcade -H npm run db:prisma:baseline -- --dry-run` 으로 "표시 N · 미적용 M" 을 보고, 맞으면 `-- --dry-run` 없이. 그다음 설치를 다시 |
| 3단계 · 코드 4 | 지난 배포에서 실패한 마이그레이션이 남았다. 그대로 deploy 하면 P3009 | 그 마이그레이션이 DB 에 남긴 것을 확인(배포 직전 덤프와 비교)한 뒤 `npx prisma migrate resolve --rolled-back <이름>`(되돌렸으면) 또는 `--applied`(손으로 끝냈으면) |
| 6단계 | 마이그레이션이 실패했다. **서비스는 멈춰 있다** | 스크립트가 찍은 순서대로: ① `pg_restore` 로 배포 직전 덤프 복원 ② 이전 묶음을 `SKIP_MIGRATE=1` 로 설치 ③ `systemctl start arcade-finder`. 원인을 고쳐 다시 배포할 때는 실패 표시부터 `migrate resolve --rolled-back` |

- **배포 직전 덤프**: 적용할 마이그레이션이 있을 때만 `/var/backups/arcade-finder/pre-deploy-<묶음>-<시각>.dump` 로 뜹니다(최근 3개). 매일 백업(`db-*.dump`, 7일)과 따로입니다.
- **하지 말 것**: 적용된 마이그레이션 파일을 고치기(주석 포함) · `prisma migrate dev` / `migrate reset` · `db:init` / `db:reset` · 기준점 없는 DB 에 `SKIP_MIGRATE=1` 로 우회하기(서비스가 뜨지 않은 채 끝납니다).
- 운영 DB 상태를 재는 명령(읽기만): `sudo -u arcade -H npx prisma migrate status` · `psql -c "SELECT count(*), max(migration_name), count(*) FILTER (WHERE finished_at IS NULL) FROM _prisma_migrations"`

## 3. 백업

`deploy/backup.sh` 가 매일 04:00(timer) 다음을 `/var/backups/arcade-finder/` 에 둡니다:

- `db-<날짜>.dump` — `pg_dump -Fc` (176MB 급 DB 가 30MB 대로 압축됩니다)
- `uploads-<날짜>.tar.zst` — 첨부 원본(`uploads/posts/`). **DB 밖 파일**이라 덤프에 없습니다.
  첨부가 바뀌지 않아 묶음이 옛것과 바이트까지 같으면 옛것은 지우고 새것만 남깁니다. 그래서 날짜가
  빠져 있으면 **그 뒤 첫 묶음이 그날 상태**입니다
- 7일 지난 것은 지웁니다 (`KEEP_DAYS`, `arcade-finder-backup.service`). 14일치가 10GB 서버에서 600MB 를 차지해 2026-10-16 에 줄였습니다. 더 오래 둘 것은 PC 로 받아 두세요

다른 장비로 복사하지 않으면 백업이 아닙니다 — 스크립트 끝의 `OFFSITE` 훅에 rclone/scp
한 줄을 넣으세요.

## 4. 복구 (리허설 포함)

**출시 전에 한 번 실제로 해 보세요.** 되는지 모르는 백업은 없는 것과 같습니다.

**리허설은 스크립트 하나로 합니다** (2026-11-24) — 아래 1~3 단계를 임시 DB · 임시 폴더에서 돌리고 지웁니다.
운영 DB · 첨부 · 서비스는 건드리지 않습니다(운영 DB 에는 행 수를 세는 SELECT 만).

```bash
sudo bash /srv/arcade-finder/app/arcade-finder/deploy/ncp/restore-rehearsal.sh     # 가장 최근 백업으로
```

덤프를 새 DB 에 복원(시간 측정) → 표마다 행 수를 운영과 나란히 · 마이그레이션 이력 비교 → 첨부 묶음을 풀어
DB 가 가리키는 첨부가 다 있는지 → 그 DB 로 앱을 3900 번에 하나 더 띄워 health · 오락실 · 글 · 서열표 · 첫 화면 →
지우기. 결과는 `/var/backups/arcade-finder/restore-rehearsal-<시각>.log`. 남은 메모리+스왑이 600MB 보다 적으면
앱 띄우기는 건너뜁니다(`NO_APP=1` 로 직접 끌 수도). 실제 복구로 이어가려면 `KEEP=1` 로 돌려 임시 DB 를 남긴 뒤
아래 4단계의 이름 교체를 그 DB 로 하세요.

손으로 할 때는:

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

RPO 는 하루(백업 주기)입니다. 더 줄이려면 timer 를 `*:00/6` 같은 식으로 좁히세요.
덤프는 30초 안에 끝납니다.

## 5. 출시 체크리스트

- [ ] `.env.local` 운영 필수 8개 채움 → `npm run build && NODE_ENV=production node -e "require('./.next/server/app/api/health/route.js')"` 대신 그냥 서비스를 띄워 `journalctl` 에 `[env] ✗` 가 없는지 확인
- [ ] NCP 콘솔 Maps > Web 서비스 URL 에 **운영 도메인** 등록 (안 하면 FallbackMap 으로 뜹니다 — 이제 조용히 실패하지 않고 그리로 갑니다)
- [ ] Google·카카오·네이버 콘솔에 `https://<도메인>/api/auth/oauth/<provider>/callback` 등록, 카카오·네이버 심사에 `/privacy` URL 제출
- [ ] `/terms` · `/privacy` 에 자리표시자 경고가 안 보이는지
- [ ] 히스토리에 노출됐던 키(`83fb7d6`: Gemini 키 · 지도 키 ID) 재발급 확인
- [ ] `npm run db:purge-demo` — 시드 글·가상 오락실 확인 후 `-- --apply`
- [ ] 묶음은 **커밋한 뒤** 만든다 — `build-release.sh` 는 커밋하지 않은 변경(추적 안 하는 새 파일 포함)이 있으면 멈춥니다. 시험용만 `ALLOW_DIRTY=1` (이름에 `-dirty`). 묶음에 `VERSION` 이 들어가 `/api/health` 의 `version` 이 커밋 해시가 되고, `install-release.sh` 가 떠 있는 판이 묶음과 다르면 경고합니다 (2026-11-20)
- [ ] 첨부 청소 — 가끔 `sudo -u arcade -H bash -c "cd <앱 폴더> && npm run uploads:purge"` 로 미리 보고 `-- --write`. 쓰다 만 글의 첨부 · 지운 글의 파일을 치웁니다(업로드 라우트도 덤으로 조금씩 치움)
- [ ] `npm run data:release -- verify <폴더>` — 외부 원천 데이터가 다 들어갔는지 (종료 코드 0)
- [ ] `npm run arcades:dedupe` — 중복 오락실 확인 후 `-- --apply`
- [ ] 복구 리허설 1회 (§4 — `deploy/ncp/restore-rehearsal.sh` · 1GB 리허설 서버에서는 2026-11-24 통과)
- [ ] CI 초록 (`.github/workflows/ci.yml`)
- [ ] `curl -I https://<도메인>/robots.txt` · `/sitemap.xml` · `/opengraph-image` 200
- [ ] **지도 키를 넣은 뒤 브라우저 콘솔에 CSP 위반이 없는지** — 네이버 지도 SDK 는 로컬에 키가 없어 검증하지 못했습니다. 막히면 `next.config.mjs` 의 `script-src`·`connect-src`·`img-src` 에 그 도메인을 더하세요
