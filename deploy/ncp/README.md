# 네이버 클라우드(NCP) 베타 배포

> 2026-09-29 작성. 대상: **NCP Micro 서버(mi1-g3 · 1vCPU · 1GB) 한 대** + 무료 주소(`<공인IP>.sslip.io`).
> 앱 · PostgreSQL 18 · Caddy(HTTPS)가 모두 그 한 대에서 돕니다. 서버 구성의 원본은 [../README.md](../README.md)(systemd · 백업 · 복구)이고,
> 이 폴더는 그것을 **작은 서버에 맞춰 자동으로 까는 스크립트**입니다.

## 0. 한눈에

| | |
|---|---|
| 월 비용 | Micro 서버 무료(결제 정보 최초 등록 월부터 1년) + 공인 IP 4,032원 + VAT ≈ **4,400원** |
| 빌드 | **PC 의 Docker(리눅스 컨테이너)** 에서. 서버에서는 하지 않습니다 — `next build` 가 3.2GB 를 씁니다 |
| 첫 설치 | `bootstrap.sh`(한 번) → `install-release.sh` → 데이터 채우기 |
| 이후 배포 | PC 에서 `build-release.sh` → 올리기 → 서버에서 `install-release.sh` (약 15초 끊김) |
| 감시 (선택) | 서버 안 수집기가 Grafana Cloud(무료)로 지표를 보냄 → 그래프 · 알림은 Grafana Cloud 에서 — §9 |

**2026-09-29 리허설 결과** — 메모리 1GB · CPU 1개로 묶은 Ubuntu 24.04 + systemd 컨테이너에서 처음부터 끝까지 돌렸습니다.

| 항목 | 값 |
|---|---|
| 배포 묶음 | 223MB, PC 에서 2분 13초 |
| 첫 설치 (마이그레이션 89개 포함) | 56초 → `/api/health` 200 |
| 다시 배포 | 14초 |
| 메모리 (쉴 때 → 페이지 8종 × 15회 동시 요청 중 최대) | 앱 211MB + DB 119MB → **앱 267MB + DB 248MB** |
| 디스크 | 앱 872MB · 묶음 223MB/개(2개 보관) · DB 110MB · 스왑 2GB |
| 확인한 것 | Caddy 경유 HTTPS 200, 홈 ISR 재생성이 `.next` 에 기록됨, 백업 작업, 개발 DB 복원 → 실제 오락실 926곳 |

---

## 1. 콘솔에서 할 일 (직접)

크레딧이 쓰이는 조작이라 콘솔에서 직접 해 주세요. 메뉴 이름은 콘솔 개편에 따라 조금 다를 수 있습니다.

1. **크레딧 확인** — 비용 관리 → 크레딧에서 잔액과 **만료일**을 봅니다. Micro 가 무료인지는 "결제 정보 최초 등록 월부터 1년" 인지로 판단합니다.
2. **VPC · Subnet** — Networking → VPC 에서 VPC(예: `10.0.0.0/16`) 하나, 그 안에 **Public** Subnet(예: `10.0.1.0/24`, 용도 일반) 하나.
3. **서버 생성** — Compute → Server → 서버 생성
   - 이미지: **Ubuntu 24.04** (없으면 22.04 — 스크립트가 둘 다 됩니다)
   - 서버 타입: **Micro · mi1-g3** (1vCPU · 1GB)
   - 스토리지: 기본 **10GB** (무료분. 넘기면 전체 용량이 과금됩니다)
   - 인증키: 새로 만들고 `.pem` 을 **잃어버리지 않게** 보관 (관리자 비밀번호를 꺼내는 데 씁니다)
4. **ACG(방화벽)** — 서버에 붙은 ACG 의 인바운드 규칙
   | 프로토콜 | 포트 | 허용 대상 | 용도 |
   |---|---|---|---|
   | TCP | 22 | **내 IP 만** (`x.x.x.x/32`) | SSH |
   | TCP | 80 | `0.0.0.0/0` | HTTPS 인증서 발급 · http→https |
   | TCP | 443 | `0.0.0.0/0` | 서비스 |
5. **공인 IP** — Server → Public IP → 신청 → 위 서버에 할당. 이 주소가 곧 서비스 주소가 됩니다
   (예: `223.130.1.2` → `https://223-130-1-2.sslip.io`).
6. **관리자 비밀번호** — 서버 목록 → 서버 관리 및 설정 변경 → 관리자 비밀번호 확인 → `.pem` 올리기.

## 2. PC 에서 만들 것

Git Bash 에서, `arcade-finder/` 폴더 기준입니다. Docker Desktop 이 켜져 있어야 합니다.

```bash
# 1) 빌드 때 들어갈 공개 값 — APP_URL 을 위 5번의 주소로
cp deploy/ncp/build.env.example deploy/ncp/build.env
#    APP_URL=https://223-130-1-2.sslip.io · NEXT_PUBLIC_NAVER_MAP_KEY_ID · 운영자 이름 · 연락 메일을 채움

# 2) 배포 묶음 (2분 남짓)
bash deploy/ncp/build-release.sh          # → deploy/ncp/out/release-<시각>-<커밋>.tgz

# 3) 서버로 가져갈 API 키 — PC 의 .env.local 에서 골라 냄 (값은 화면에 안 나옴)
bash deploy/ncp/make-server-env.sh        # → deploy/ncp/server.env
```

`server.env` 에는 지도 · 검색 · 로그인 · AI · 메일 키가 들어갑니다. DB 주소 · `AUTH_SECRET` · 관리자 비밀번호는
**넣지 않습니다** — 서버가 새로 만듭니다(개발용 값을 운영에 쓰지 않게).

## 3. 서버에 올리고 설치

```bash
IP=223.130.1.2
# release-<새것> 은 build-release.sh 가 마지막에 찍어 준 이름. release-*.tgz 로 쓰면 out/ 의 옛 묶음까지 올라간다
scp deploy/ncp/bootstrap.sh deploy/ncp/Caddyfile deploy/ncp/install-release.sh \
    deploy/ncp/out/release-<새것>.tgz deploy/ncp/server.env  root@$IP:/root/
ssh root@$IP
```

서버에서:

```bash
cd /root
sudo SITE_DOMAIN=223-130-1-2.sslip.io bash bootstrap.sh     # 5분 안팎 — Node · PostgreSQL · Caddy
sudo bash install-release.sh release-<새것>.tgz server.env   # 1분 — 마이그레이션 89개 + 기동 확인 (이름은 끝까지)
rm server.env                                               # 합쳤으면 지운다 (PC 쪽 사본도)
cat /root/arcade-finder-secrets.env                         # 관리자 비밀번호 (닉네임 '관리자')
```

이 시점의 DB 는 **마이그레이션만 적용된 빈 DB** 라 실제 오락실이 없고, 가상 오락실 8곳 · 시드 계정 12개 · 시드 글 30개만
있습니다. 다음 단계로 채웁니다.

## 4. 데이터 채우기 — 개발 DB 복원

리허설에서 확인한 순서입니다. 개발 DB 의 **실제 오락실 926곳 · 곡 · 채보를 그대로** 가져가고, 시드 데이터를 지웁니다.

⚠ 이 방법은 개발 DB 의 **계정 · 글 · 리뷰까지 함께** 옮깁니다(내가 만든 테스트 계정 포함). 기준 데이터만 옮기는
도구(`npm run data:release`)는 `portfolio-backend-optimization` 워크트리에 미커밋으로 있어, 그것을 main 에 합친 뒤라면 그쪽이 더 깔끔합니다.

PC 에서 (개발 DB 는 읽기만 합니다):

```bash
U="$(grep ^DATABASE_URL= .env.local | cut -d= -f2- | tr -d '"\r')"
"/c/Program Files/PostgreSQL/18/bin/pg_dump.exe" -w -Fc --no-owner --no-privileges --dbname="$U" --file=deploy/ncp/out/dev.dump
scp deploy/ncp/out/dev.dump root@$IP:/tmp/
```

서버에서:

```bash
APP=/srv/arcade-finder/app/arcade-finder
systemctl stop arcade-finder
sudo -u postgres dropdb arcade_finder && sudo -u postgres createdb -O arcade -E UTF8 -T template0 arcade_finder
chmod 644 /tmp/dev.dump && sudo -u postgres pg_restore --no-owner --role=arcade -d arcade_finder /tmp/dev.dump
cd $APP
sudo -u arcade -H node scripts/prisma-baseline.mjs        # "89개를 적용됨으로 표시" — DDL 은 실행하지 않음
sudo -u arcade -H npm run db:migrate:prisma               # "No pending migrations" 가 정상
sudo -u arcade -H npm run db:purge-demo                   # 지울 목록만 보기
sudo -u arcade -H npm run db:purge-demo -- --apply        # 시드 글 · 가상 오락실 삭제 (리허설: 글 28개)
systemctl start arcade-finder
rm /tmp/dev.dump                                          # 계정 정보가 든 파일 — PC 쪽 사본도 지운다
```

**첨부 파일도 옮깁니다.** DB 에는 파일 이름(`post_images.storage_key`)만 있고 사진 · 동영상은 PC 의 `uploads/posts/` 에
있습니다. 안 옮기면 글은 보이는데 첨부만 안 뜹니다. 배포 묶음에는 일부러 넣지 않고, install-release 도 서버의 `uploads/` 는 건드리지 않습니다.

```bash
# PC
scp -r uploads/posts root@$IP:/srv/arcade-finder/app/arcade-finder/uploads/
# 서버 — scp 로 만든 폴더는 root 것이라, 앱(arcade)이 새 첨부를 쓸 수 있게 주인을 바꾼다
chown -R arcade:arcade /srv/arcade-finder/app/arcade-finder/uploads
```

## 5. 외부 콘솔에 주소 등록

주소(`https://223-130-1-2.sslip.io`)가 정해졌으니 다음 세 곳에 넣습니다. 안 하면 그 기능만 조용히 안 됩니다.

| 어디 | 무엇 | 안 하면 |
|---|---|---|
| NCP 콘솔 — 지도 키를 만든 Application 의 **Web 서비스 URL** | `https://223-130-1-2.sslip.io` | 지도 인증 실패 → 대체 지도로 뜸 |
| Google Cloud 콘솔 · 카카오 개발자 · 네이버 개발자 | 콜백 `https://<주소>/api/auth/oauth/{google,kakao,naver}/callback` — 아래 표 | 그 소셜 로그인만 실패 |

소셜 로그인 콘솔은 곳마다 넣는 칸이 다릅니다. `localhost` 로 등록해 둔 줄은 지우지 말고 **하나 더** 넣으세요 — 개발 서버도 계속 로그인됩니다.

| 콘솔 | 넣는 곳 | 빠졌을 때 보이는 것 |
|---|---|---|
| Google Cloud | API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 → **승인된 리디렉션 URI**. 앱이 '테스트' 상태면 테스트 사용자만 로그인됩니다 | `400 redirect_uri_mismatch` |
| 카카오 개발자 | 카카오 로그인 **리다이렉트 URI** + 플랫폼 Web **사이트 도메인**(`https://<주소>`) | 로그인한 **뒤에** `KOE006` (인가 화면까지는 넘어가서 늦게 드러납니다) |
| 네이버 개발자 | API 설정 → 로그인 오픈 API 서비스 환경 PC 웹 → **Callback URL**(최대 5개) · 서비스 URL. '개발 중' 상태면 멤버 관리에 넣은 아이디만 로그인됩니다 | "서비스 설정에 오류가 있어 네이버 아이디로 로그인할 수 없습니다" |

등록됐는지는 로그인하지 않고도 볼 수 있습니다 — `curl -s -o /dev/null -w '%{redirect_url}\n' https://<주소>/api/auth/oauth/google` 이 내주는 주소를 브라우저로 열어 위 오류가 뜨는지 보면 됩니다.
| Resend | (선택) `MAIL_FROM` 도메인 인증 | 인증 메일이 가입한 본인 주소로만 감. **sslip.io 는 DNS 를 바꿀 수 없어 인증할 수 없습니다** — 도메인을 사야 합니다. 인증 메일이 안 가도 가입 · 로그인 · 글쓰기는 됩니다 |

## 6. 이후 배포

```bash
# PC
bash deploy/ncp/build-release.sh
scp deploy/ncp/out/release-<새것>.tgz root@$IP:/root/
# 서버
sudo bash install-release.sh /root/release-<새것>.tgz
```

- **되돌리기**: `/srv/arcade-finder/releases/` 에 직전 묶음이 남아 있습니다 → `sudo bash install-release.sh /srv/arcade-finder/releases/<직전>.tgz`.
  마이그레이션은 되돌리지 않으니, 스키마를 바꾼 배포를 되돌릴 때는 코드가 새 스키마에서도 도는지 먼저 보세요.
- **지도 키 · APP_URL 을 바꿨다면** `build.env` 를 고치고 **다시 빌드**해야 합니다 (빌드 때 박히는 값).
- 서버 쪽 키(`server.env` 에 있던 것)만 바꿀 때는 `/srv/arcade-finder/app/arcade-finder/.env.local` 을 고치고 `systemctl restart arcade-finder`.

## 7. 운영

| 하려는 일 | 명령 (서버) |
|---|---|
| 상태 | `curl -s localhost:3000/api/health` · `systemctl status arcade-finder` |
| 로그 | `journalctl -u arcade-finder -f` · Caddy: `/var/log/caddy/arcade-finder.log` |
| 메모리 · 디스크 | `free -m` · `df -h /` |
| 백업 (매일 04:00 자동) | `/var/backups/arcade-finder/` — **PC 로도 받아 두세요**: `scp root@$IP:/var/backups/arcade-finder/db-*.dump .` |
| 관리자 비밀번호 | `/root/arcade-finder-secrets.env` (바꾸려면 `.env.local` 의 `ADMIN_PASSWORD` 수정 후 재시작) |
| 패키지 업데이트 | `apt upgrade` 는 해도 되지만 **커널은 bootstrap 이 고정**해 둡니다 — NCP 가 Ubuntu 커널 업데이트를 지원하지 않습니다. `apt-mark unhold` 하지 마세요 |
| 감시 (Grafana Cloud) | §9-5 |

## 8. 문제가 생기면

- **HTTPS 가 안 열린다** — `journalctl -u caddy -n 50`. 인증서 발급 실패면 ① ACG 에 80 · 443 이 열렸는지 ② 주소의 IP 가
  공인 IP 와 같은지. sslip.io 는 여러 사람이 같이 쓰는 주소라 Let's Encrypt 발급 한도에 걸릴 수 있습니다 — 그러면
  `nip.io` 로 바꾸거나(`/etc/caddy/Caddyfile` 과 `.env.local` 의 `APP_URL`, 그리고 다시 빌드) 도메인을 사세요.
- **메모리가 모자라다** (`journalctl` 에 heap · killed) — 콘솔에서 서버를 정지하고 스펙을 **c2-g3(2vCPU · 4GB, 월 약 8.4만 원)** 으로 바꾼 뒤,
  `sudo SITE_DOMAIN=… bash bootstrap.sh` 를 다시 돌리면 메모리에 맞춰 인스턴스 2개 · 기본 설정으로 바꿉니다.
- **`[env] 운영 필수 설정 N건이 빠져`** — `.env.local` 에 빠진 키가 로그에 이름으로 나옵니다 (`lib/env-check.ts`).
- **`없음: release-….tgz`** — 그 묶음이 서버에 없습니다. 같은 메시지 아래에 서버에 있는 묶음 목록이 나오니, 없으면 PC 에서 다시 scp.
- **`디스크가 모자랍니다`** — install-release 가 풀기 전에 멈춘 것입니다(아무것도 바뀌지 않음). `ls -la /root /srv/arcade-finder/releases` 에서
  다 쓴 묶음을 지우고 `apt-get clean` 뒤 다시. 묶음이 수백 MB 가 아니라 1GB 를 넘으면 빌드에 쓸데없는 것이 섞인 것입니다.
- **`✗ … 번째 줄에서 멈췄습니다`** — 두 스크립트 모두 멈춘 줄과 명령을 찍습니다. 그 위 몇 줄이 실제 원인입니다.

## 9. 감시 — Grafana Cloud (선택)

> 2026-10-06 작성. 1GB · CPU 1개 컨테이너에서 처음부터 끝까지 리허설했고(Grafana Cloud 자리에는 그것과 같은 엔진인
> Grafana Mimir), **같은 날 실서버에 적용했습니다** — 지표 도착(활성 시계열 약 1,000) · 대시보드 · 디스크 칸(ext4)까지 확인.
> 실서버에서 드러난 것 하나: 알림 규칙은 Grafana 관리 규칙으로 가져와야 메일이 갑니다(9-4).

서버 안에서 수집기(Prometheus agent 모드) · node_exporter · postgres_exporter 가 60초마다 지표를 긁어 Grafana Cloud
무료 등급으로 보냅니다. 그래프와 알림은 Grafana Cloud 화면에서 봅니다. 셋 다 127.0.0.1 에만 열려 서버에 열리는 포트는
늘지 않고, 앱의 `/api/metrics` 는 Caddy 가 밖에서 404 로 막습니다. 저장 · 질의 · 알림 평가는 Grafana Cloud 가 하므로
1GB 서버에 Prometheus · Grafana 를 통째로 올리는 것보다 훨씬 가볍습니다.

| 리허설 | 값 |
|---|---|
| 설치 | 40초. 앱을 한 번 다시 띄웁니다(10~20초 끊김). 다시 돌리면 앱은 건드리지 않습니다 |
| 메모리 (부하 뒤) | 수집기 32MB(최대 47MB) · node_exporter 7MB · postgres_exporter 8MB. 서비스마다 상한을 걸어 넘치면 그것만 다시 뜹니다 |
| CPU | 수집기 0.8% · exporter 둘 합쳐 0.1% (vCPU 1개 기준) |
| 디스크 | 294MB (`/opt/arcade-monitoring`) |
| 시계열 | 1,713개 (앱 557 · 서버 530 · DB 591 · Caddy 35) — 무료 등급은 10,000개 · 14일 보관 |
| 감시를 켠 채 부하 | k6 `peak` 5분 — p95 13ms · p99 22ms · 실패 0% (시드 데이터 DB) |

### 9-1. Grafana Cloud 준비 (직접)

1. <https://grafana.com> 에서 무료로 가입하고 스택(Stack)을 하나 만듭니다. 지역은 가까운 곳으로.
2. grafana.com 의 내 스택 → **Prometheus** 의 **Details** 에서 세 가지를 적어 둡니다 (화면 이름은 바뀔 수 있습니다).
   - **Remote Write Endpoint** — 끝이 `/api/prom/push` 인 주소
   - **Username / Instance ID** — 숫자
   - **토큰** — `glc_…`. 같은 화면의 **Generate now** 로 만들거나 Access Policies 에서 `metrics:write` 범위로 만듭니다.
     만들 때 한 번만 보입니다. **견본(`grafana-cloud.env.example`)이 아니라 사본(`grafana-cloud.env`)에 넣으세요** —
     견본은 git 이 추적합니다(넣으면 `build-release.sh` 가 멈춥니다).

### 9-2. PC

```bash
# 위 세 값을 채운다 — 이 사본은 커밋되지 않고(.gitignore) 배포 묶음에도 들어가지 않는다(build-release.sh)
cp deploy/ncp/monitoring/grafana-cloud.env.example deploy/ncp/grafana-cloud.env

bash deploy/ncp/build-release.sh          # 감시가 들어간 판으로 새 묶음
scp deploy/ncp/out/release-<새것>.tgz deploy/ncp/grafana-cloud.env root@$IP:/root/
```

### 9-3. 서버

```bash
cd /root
tar -xzOf release-<새것>.tgz ./deploy/ncp/install-release.sh > install-release.sh   # 스크립트도 새 판으로
sudo bash install-release.sh release-<새것>.tgz                                   # 재배포는 인자 하나
sudo bash /srv/arcade-finder/app/arcade-finder/deploy/ncp/monitoring/install-monitoring.sh /root/grafana-cloud.env
rm /root/grafana-cloud.env                                                       # PC 쪽 사본도 지운다
```

`install-monitoring.sh` 가 하는 일: 바이너리 셋을 GitHub 릴리스에서 받아 sha256 을 맞춰 보고 → 앱 지표 토큰(`METRICS_TOKEN`)을
**서버에서** 만들어 `.env.local` 에 넣고 → DB 에 읽기 전용 감시 계정(`arcade_monitor`, `pg_monitor` 역할)을 만들고 →
Caddyfile 을 묶음의 새 판으로 바꾸고(옛 판은 `/etc/caddy/Caddyfile.bak-*`) → 서비스 셋을 띄우고 → 앱을 한 번 다시 띄운 뒤 →
Grafana Cloud 가 받았는지, 밖에서 `/api/metrics` 가 막혔는지 확인합니다. 알림 규칙은 올리지 않습니다(9-4 에서 화면으로).

끝에 `✔ Grafana Cloud 가 받았습니다` 가 나오면 됩니다. 못 보내면 그 자리에서 멈추고 Grafana Cloud 가
돌려준 응답을 찍습니다 — 401/403 이면 토큰 · Instance ID, 404 면 URL 입니다. 고친 `grafana-cloud.env` 로 같은 명령을 다시
돌리면 됩니다.

### 9-4. Grafana Cloud 화면 (직접)

1. **대시보드** — Dashboards → New → Import → PC 의 `monitoring/grafana/dashboards/arcade-finder.json` 을 올립니다.
   맨 위 **데이터 소스** 칸에서 스택의 Prometheus(`grafanacloud-…-prom`)를 고릅니다. 로컬과 같은 대시보드이고,
   "서버 · Caddy" 줄과 "메모리 여유" · "디스크 여유" 칸은 운영에서만 찹니다.
2. **알림 받을 메일** — Alerting → Notification configuration → **Contact points**. 새 스택에는 `empty` 라는 연락 지점 하나가
   기본 정책(Default policy)에 걸려 있고 **받는 곳이 비어 있습니다**(No integrations configured) — 그대로면 알림이 아무 데도
   안 갑니다. `empty` 의 **Edit** → Integration **Email** · Addresses 에 메일 → **Save contact point**. 이름은 그대로 두세요
   (기본 정책이 그 이름을 가리킵니다).
3. **알림 규칙 가져오기** — Alerting → Alert rules → **More → Import alert rules** →
   - Import source: **Prometheus YAML file** → PC 의 `deploy/ncp/monitoring/rules.yml`
   - Target data source: `grafanacloud-…-prom`
   - Target folder: **New folder** `arcade-finder`
   - **Pause imported alerting rules 는 끕니다**(기본이 켜짐 — 켜 두면 규칙이 멈춘 채로 들어옵니다)
   - Import → 확인 창에서 Import. 폴더 `arcade-finder` 아래 `arcade-finder-prod` 에 12개가 생깁니다.

   **왜 이렇게 하나**: 처음 판은 `install-monitoring.sh` 가 mimirtool 로 Grafana Cloud 의 Prometheus(Mimir)에 규칙을 올렸습니다.
   실서버에서 그 규칙은 평가는 됐지만(`DiskLow` firing) 알림이 Grafana 의 연락 지점으로 오지 않았습니다 — 스택의 Prometheus
   데이터 소스가 `manageAlerts: false` 라 Alert rules 화면에도 안 보이고 "Existing data source-managed rules" 로도 못 가져옵니다.
   그 판으로 설치한 서버라면 Mimir 쪽 사본 12개가 조용히 평가되고 있는데, 알림을 내지 않으니 두어도 됩니다.
4. **울려 보기** — 서비스에 영향 없이: `sudo systemctl stop arcade-postgres-exporter` → 4~5분 뒤 `PostgresDown` 메일
   (exporter 만 멈춘 것이라 DB · 앱은 그대로) → `sudo systemctl start arcade-postgres-exporter`.

### 9-5. 운영

| 하려는 일 | 명령 (서버) |
|---|---|
| 상태 | `systemctl status arcade-prometheus-agent arcade-node-exporter arcade-postgres-exporter` |
| 보내지는지 | `curl -s 127.0.0.1:9090/metrics \| grep -E '^prometheus_remote_storage_samples_(total\|failed_total)'` — failed 가 늘면 토큰 만료 등 |
| 무엇을 긁는지 | `curl -s 127.0.0.1:9090/api/v1/targets` |
| 로그 | `journalctl -u arcade-prometheus-agent -f` |
| 토큰 · 주소 바꾸기 | 새 `grafana-cloud.env` 로 `install-monitoring.sh` 를 다시 (앱은 다시 띄우지 않음) |
| 알림 규칙 고치기 | `rules.yml` 을 고친 뒤 Grafana Cloud 에서 `arcade-finder-prod` 그룹을 지우고 9-4 의 3 으로 다시 가져오기 (서버는 그대로) |
| 수집 설정 고치기 | `deploy/ncp/monitoring/` 을 고쳐 새 묶음 → `install-release.sh` → `install-monitoring.sh` 다시 |
| 끄기 | `sudo bash …/install-monitoring.sh --remove` — 서비스 · 바이너리 · 설정 · DB 감시 계정을 지움. 앱 · DB 는 그대로 |

- Grafana Cloud 가 잠깐 받지 못해도 수집기가 6시간까지 쌓아 두었다가 다시 보냅니다.
- 리허설 컨테이너에서는 "디스크 여유" 가 비었지만(루트가 overlay 라 node_exporter 가 건너뜀), 실서버(ext4 `/dev/vda2`)에서는
  찹니다 — 2026-10-06 첫 측정이 14% 라 바로 `DiskLow` 가 울렸습니다. 다 쓴 배포 묶음(하나에 224MB)부터 지우세요.
- 수집 간격은 60초입니다. Grafana Cloud 는 사용량을 시계열 수와 1분당 점 수로 세므로 더 줄이지 마세요.
