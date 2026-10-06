# 로컬 감시 — Prometheus · Grafana

> 2026-10-06 작성. **PC 전용**입니다. 운영 서버(NCP Micro 1GB)에는 아직 올리지 않습니다 — 맨 아래 "운영으로 가져가려면".

PC 에서 돌리는 `npm run dev`(또는 `start:cluster`)를 Prometheus 가 15초마다 긁고, Grafana 가 대시보드로 보여 줍니다.
개발 DB(PostgreSQL 18)는 postgres_exporter 가 따로 봅니다. 셋 다 Docker 컨테이너이고 앱은 컨테이너 밖에서 돕니다.

```
 PC                                         Docker (monitoring/docker-compose.yml)
 ┌──────────────────────────┐               ┌──────────────────────────────────────────┐
 │ npm run dev  :3000       │◀── 15초마다 ──│ Prometheus :9090 ──▶ Grafana :3300       │
 │   GET /api/metrics       │   Bearer 토큰  │      ▲                                   │
 │ PostgreSQL 18 :5432      │◀──────────────│ postgres_exporter                        │
 └──────────────────────────┘               └──────────────────────────────────────────┘
```

| 무엇 | 어디서 |
|---|---|
| 라우트별 요청 수 · 응답 시간 · 상태 코드 | `lib/telemetry-node.ts` — Next 가 내는 OpenTelemetry 스팬 (라우트 파일은 그대로) |
| Prisma 연산별 호출 수 · 시간 · 실패 | `lib/prisma.ts` 의 `$extends` |
| pg 풀 (열린 · 쉬는 · 기다리는 커넥션) | `lib/prometheus.ts` 가 긁는 순간 풀에서 읽음 |
| 힙 · GC · CPU · 이벤트 루프 지연 | Node 기본 지표 |
| 접속 · 트랜잭션 · 캐시 적중률 · DB 크기 | postgres_exporter |

재는 지점은 Pulse 계측과 같습니다. Pulse 는 30초마다 앱이 p95 를 계산해 보내고, Prometheus 는 누적 값을 긁어 가서 그쪽에서
계산합니다. 둘을 함께 켜도 서로 간섭하지 않습니다.

## 1. 처음 한 번

Docker Desktop 이 켜져 있어야 합니다.

```bash
# 1) 토큰 하나 만들기
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 2) 앱 .env.local 에 그 값을 METRICS_TOKEN= 으로 넣고 dev 서버를 다시 띄운다
#    로그에 "[telemetry] 계측 시작 — … Prometheus → GET /api/metrics" 가 나오면 켜진 것

# 3) monitoring/.env 만들기 — 같은 토큰 + 개발 DB 주소(호스트만 host.docker.internal)
cp monitoring/.env.example monitoring/.env
```

## 2. 켜고 끄기

```bash
cd monitoring
docker compose up -d        # 켜기
docker compose down         # 끄기 (모은 지표는 볼륨에 남는다)
docker compose down -v      # 지표까지 지우기
```

- Grafana — <http://localhost:3300> (보기는 로그인 없이. 첫 화면이 "오락실 파인더" 대시보드. 고치려면 Sign in → `admin` /
  `GRAFANA_ADMIN_PASSWORD`, 비워 두면 `admin`)
- Prometheus — <http://localhost:9090> · 수집 대상 <http://localhost:9090/targets> · 알림 <http://localhost:9090/alerts>

포트는 127.0.0.1 에만 열립니다. Grafana 가 로그인 없이 보이고 관리자 비밀번호도 기본값일 수 있기 때문입니다.

## 3. 대시보드 읽는 법

맨 위 여섯 칸이 한눈에 볼 것입니다(앱 상태 · 초당 요청 · 응답 p95 · 5xx 비율 · DB 풀 대기 · 울리는 알림). 그 아래 네 줄은
요청 → DB → Node 프로세스 → PostgreSQL 순서입니다.

**느릴 때는 "느린 이유 가르기" 패널부터** 보세요. 세 선을 겹쳐 둔 것입니다.

| 오른 것 | 뜻 |
|---|---|
| 요청 p95 만 | 앱 코드 (렌더링 · 외부 API) |
| 요청 p95 + DB 연산 p95 | 쿼리 쪽 — "연산별 p95" 에서 어느 연산인지 |
| 셋 다 (이벤트 루프 지연까지) | Node 프로세스가 CPU 로 밀림. 쿼리가 무죄여도 DB 시간이 길게 찍힙니다 |

DB 연산 시간은 **코드가 체감한 시간**이라 풀 대기와 이벤트 루프 지연이 함께 들어갑니다(`lib/telemetry.ts` 머리말).
풀 대기는 "pg 풀 커넥션" 의 `waiting` 으로 따로 봅니다 — 0 이 정상입니다.

> dev 서버는 라우트를 처음 열 때마다 컴파일하느라 그 순간 응답 시간과 이벤트 루프 지연이 크게 튑니다. 숫자를 비교하려면
> `npm run build && npm run start:cluster` 로 띄우세요(아래).

### 지표 이름

| 지표 | 라벨 |
|---|---|
| `arcade_http_request_duration_seconds` (히스토그램 — `_count` 가 요청 수) | `method` · `route`(라우트 패턴) · `status` |
| `arcade_db_operation_duration_seconds` (히스토그램) | `operation`(`findMany posts` · `SELECT arcades`) · `outcome`(`ok`/`error`) |
| `arcade_db_pool_connections` | `state`(`total` · `idle` · `waiting` · `max`) |
| `arcade_app_info` | `version` |
| `nodejs_*` · `process_*` | Node 기본 지표 |

라우트 · 연산 종류는 각각 150 에서 자르고 넘치면 `(other)` 로 묶습니다. 봇이 아무 경로나 찔러도 시계열이 불어나지 않게 하려는 것입니다.
`/api/metrics` · `/api/health` · `/_next/*` 는 세지 않습니다.

### 대시보드 고치기

정본은 `grafana/dashboards/arcade-finder.json` 입니다. 화면에서 고쳐도 저장되지만, 남기려면 대시보드 설정 → JSON Model 을
복사해 그 파일을 덮어쓰세요(30초 안에 다시 읽습니다). 알림 문턱은 `prometheus/rules.yml` — 고친 뒤 `docker compose restart prometheus`.

## 4. 운영 빌드(`start:cluster`)를 볼 때

`start:cluster` 는 3000 에 프록시를 두고 인스턴스를 3001 · 3002 에 띄웁니다. 3000 을 긁으면 매번 다른 인스턴스가 대답해 카운터가
섞이므로 `prometheus/prometheus.yml` 의 `targets` 를 주석에 적힌 내부 포트로 바꾸고 `docker compose restart prometheus` 하세요.
그러면 `instance` 라벨로 인스턴스마다 갈립니다 (Pulse 는 이것을 못 해서 PERFORMANCE.md 에 "agent id 를 나눠야 한다" 로 남아 있습니다).

## 5. 부하 시험 겹쳐 보기 (k6)

Prometheus 가 k6 결과를 받도록 열어 두었습니다(`--web.enable-remote-write-receiver`). 같은 시간축에서 k6 가 본 응답 시간과
앱이 본 처리 시간을 나란히 볼 수 있습니다.

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write K6_PROMETHEUS_RW_TREND_STATS='p(95),p(99),avg' \
  k6 run -q -o experimental-prometheus-rw -e BASE_URL=http://localhost:3000 -e SCENARIO=peak load-test/k6-dau.js
```

지표는 `k6_http_req_duration_p95` 처럼 `k6_` 로 시작합니다(Grafana → Explore 에서 검색). 부하 시험의 규칙(빈 DB 에서 재지 않기 ·
쓰기 시나리오는 스케일 DB 에만)은 `load-test/README.md` 그대로입니다.

## 6. 문제가 생기면

| 증상 | 원인 · 고침 |
|---|---|
| 앱 상태 "내려감", targets 에 `401` | 두 `METRICS_TOKEN` 이 다름. 앱 쪽을 고쳤으면 dev 서버 재시작, monitoring 쪽이면 `docker compose up -d` |
| targets 에 `404` | 앱 `.env.local` 에 `METRICS_TOKEN` 이 없음(꺼진 상태) |
| targets 에 `connection refused` | dev 서버가 꺼졌거나 3000 이 아닌 포트로 뜸 |
| PostgreSQL 패널이 빔 · `pg_up` 0 | `PG_EXPORTER_DSN` 의 비밀번호 · 호스트. `docker compose logs postgres-exporter` |
| `docker compose` 가 엔진에 못 붙음 | Docker Desktop 이 꺼졌거나 깨진 소켓 — `%LOCALAPPDATA%\Docker\run` 을 다른 이름으로 바꾸고 다시 켜기 |

## 운영으로 가져가려면 (아직 안 함)

이 폴더는 배포 묶음에 들어가지 않고(`deploy/ncp/build-release.sh` 의 `--exclude=./monitoring`), `METRICS_TOKEN` 도 서버로 가지
않습니다(`deploy/ncp/make-server-env.sh` 의 SKIP). 운영에 붙일 때 정할 것:

- **Prometheus · Grafana 는 서버에 두지 않습니다.** Micro 1GB 에서 리허설 최대치가 앱 267MB + DB 248MB 라, 둘을 더하면 스왑에 들어갑니다.
  서버에는 가벼운 수집기와 node_exporter · postgres_exporter 만 두고, 바깥(Grafana Cloud 등)으로 원격 전송하는 쪽을 권합니다.
- **`/api/metrics` 를 Caddy 에서 막습니다.** 토큰이 있어도 공개 주소로 열어 둘 이유가 없습니다. 수집기는 서버 안에서 127.0.0.1:3001 을 긁습니다.
- postgres_exporter 는 `postgres` 대신 `pg_monitor` 역할만 가진 계정으로 붙습니다.
- Caddy 는 자체 지표(`metrics` 전역 옵션)를 낼 수 있습니다 — `naver-api-gateway-monitoring` 워크트리의 미커밋 작업(Caddy 접근 로그 → Pulse)과 겹치니 함께 정합니다.
