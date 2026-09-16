# 부하테스트

**기준은 가입자 10,000명 · DAU 3,000명입니다** (2026-09-11). 그 전까지는 "200 VU"
처럼 목표 없는 숫자로 재고 있었고, 그래서 어떤 구성이 충분한지 판단할 수 없었습니다.
자세한 경위와 수치는 `../PERFORMANCE.md` 4부.

## 파일

| 파일 | 무엇 |
|---|---|
| `capacity-model.mjs` | **가정의 정본.** 가입자·DAU 에서 피크 rps·동시 사용자를 계산합니다 |
| `k6-dau.js` | 목표 기준 **읽기** 부하 시나리오 (peak · burst · growth · ceiling) |
| `k6-write.js` | **쓰기** 부하 (mix · hotspot). 진짜로 씁니다 — 스케일 DB 에만 거세요 |
| `seed-scale.sql` | 목표 규모 데이터 생성 — 빈 DB 위의 측정은 무효라서 필요합니다 |
| `bench-server.mjs` | A/B 용 프로덕션 서버 (distDir·포트·풀 상한을 인자로) |
| `k6-read.js` | 1~3부 기준선을 낸 옛 스크립트. 그 수치와 이어 보려고 남겨 둡니다 |
| `k6-post-detail.js` | 글 상세 한 곳만 때리는 A/B 용 |

## 1. 목표 숫자 보기

```bash
node load-test/capacity-model.mjs
```

가정을 바꾸려면 그 파일의 `ASSUMPTIONS` 만 고치세요. 바뀐 '세션/s' 를
`k6-dau.js` 의 `SESSIONS_PER_SEC` 에도 옮겨 적어야 합니다(k6 는 import 를 못 합니다).

## 2. 목표 규모 데이터 만들기

**개발 DB 에는 절대 돌리지 마세요.** 별도 DB 를 만들어 씁니다.

```bash
pg_dump -w -Fc "$DATABASE_URL" -f dev.dump
```

```bash
psql -w "${DATABASE_URL%/*}/postgres" -c "CREATE DATABASE arcade_finder_scale"
```

```bash
pg_restore -w -d "${DATABASE_URL%/*}/arcade_finder_scale" dev.dump
```

```bash
psql -w "${DATABASE_URL%/*}/arcade_finder_scale" -f load-test/seed-scale.sql
```

스크립트 맨 위 가드가 DB 이름이 `_scale` 로 끝나지 않으면 거부합니다.

## 3. 재기

**반드시 프로덕션 빌드로.** `next dev` 는 수치를 크게 왜곡합니다.

```bash
npm run build
```

```bash
DATABASE_URL="${DATABASE_URL%/*}/arcade_finder_scale" node load-test/bench-server.mjs .next 3200 30
```

```bash
k6 run -q -e BASE_URL=http://localhost:3200 -e SCENARIO=peak load-test/k6-dau.js
```

시나리오는 `peak`(평시 피크) · `burst`(순간 3배) · `growth`(10배) · `ceiling`(천장 탐색).

## 4. 운영 구성으로 재기

권고 구성(인스턴스 2 × 풀 10)은 `npm run start:cluster` 로 뜹니다. 3000번 공개 포트
하나에 프록시가 붙고 인스턴스는 3001·3002 에 숨습니다.

```bash
DATABASE_URL="${DATABASE_URL%/*}/arcade_finder_scale" npm run start:cluster
```

```bash
k6 run -q -e BASE_URL=http://localhost:3000 -e SCENARIO=peak load-test/k6-dau.js
```

단일 프로세스와 비교하려면 `bench-server.mjs` 로 띄운 쪽과 번갈아 재세요.

## 5. 쓰기 부하 재기

읽기와 따로 잽니다. 쓰기는 양이 아니라 **건당 비용**과 **쏠릴 때 버티는가**가 질문입니다
(하루 1,245건 · 피크 0.062 writes/s — 읽기와 54:1).

```bash
k6 run -q -e BASE_URL=http://localhost:3000 -e SCENARIO=mix load-test/k6-write.js
```

```bash
k6 run -q -e BASE_URL=http://localhost:3000 -e SCENARIO=hotspot -e VUS=20 load-test/k6-write.js
```

`mix` 는 평시 믹스(제보·추천·리뷰·즐겨찾기)를 측정 가능한 속도로, `hotspot` 은
대회 직후처럼 **한 오락실·한 기종**에 제보가 몰리는 상황입니다 — `applyPresence` 가
`arcade_machines` 의 같은 행을 INSERT/DELETE 하는 자리가 여기서 드러납니다.

**VU 마다 계정을 하나 만들어 그 쿠키로 씁니다.** R1 이후 신원은 세션에서만 오고,
게다가 보유 기종 임계값이 `COUNT(DISTINCT player_id) >= 2` 라 **서로 다른 사람**이어야
가장 무거운 경로가 돕니다. 그래서 스케일 DB 에는 VU 수만큼 계정이 늘어납니다(정상).

## 6. A/B 로 비교할 때

처리량을 **순차로** 재면 배경 프로세스 드리프트가 효과를 덮습니다 — 같은 코드가
631 → 463 req/s 로 흘러내려 반대 결론이 난 적이 있습니다(PERFORMANCE.md 2부).
BEFORE/AFTER 를 각자 포트에 **동시에** 띄우고 번갈아 재세요.

```bash
NEXT_DIST_DIR=.next-before npm run build
```

```bash
node load-test/bench-server.mjs .next-before 3200 30
```

## 함정 모음

- **3000·3100 포트에 낡은 서버가 남아 있는지 먼저 확인하세요.** 2시간 전 프로세스가
  포트를 물고 있어서 옛 빌드를 측정한 적이 있습니다.
- **`Accept-Encoding` 을 보내야 합니다.** k6 는 기본으로 안 보내서, 그냥 재면 응답
  압축이 발동하지 않고 `data_received` 가 압축 전 크기로 잡힙니다. `k6-dau.js` 는
  브라우저와 같은 헤더를 보냅니다 — 직접 스크립트를 쓸 때 빠뜨리기 쉽습니다.
- **200 VU 구간의 실행 간 변동이 설정 간 차이만큼 큽니다.** 한 번만 재고 비교하면
  없는 차이를 만들어냅니다. 목표 부하(peak·burst) 구간은 훨씬 안정적입니다.
- **k6 의 쿠키 항아리는 반복(iteration)마다 초기화됩니다.** 로그인/가입을 첫 반복에서
  한 번만 하고 "세션을 세웠다" 는 플래그를 들고 있으면, **2회차부터 쿠키 없이** 나갑니다.
  "VU 1개면 되는데 동시 VU 면 일부가 401" 로 보여 한참 헤맸습니다 — 동시성이 아니라
  반복 문제였습니다. `k6-write.js` 는 쿠키 문자열을 직접 들고 다닙니다.
- **운영 빌드의 세션 쿠키에는 `Secure` 가 붙는데 k6 는 그걸 무시하고 평문 HTTP 로도
  보냅니다.** 브라우저는 안 보냅니다 — 이 하네스가 통과했다고 브라우저에서 되는 것은
  아닙니다.
- **빈 크라우드소싱 계층 위에서 잰 값은 쓰지 마세요.** `arcade_machines` 가 4행일
  때와 2,821행일 때 같은 부하에서 p95 가 22ms 대 152ms 입니다.
