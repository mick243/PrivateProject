# Prisma 이관 — 준비된 것과 남은 것

원시 SQL(`db/*.sql` 89개)과 원시 쿼리(`lib/*.ts` 의 `db.query` 121개)로 돌던 이 프로젝트를
**Prisma 로 옮긴** 기록입니다. 오전에는 "준비"(엔진만 바꿀 수 있는 상태)까지였고, 오후에
**데이터 계층 전체를 Prisma Client · TypedSQL 로 전환**했습니다. 앱(`lib/*.ts` · `app/api`)에는
SQL 문자열이 없고, `lib/db.ts` 는 scripts/ 전용으로 남았습니다. 중간 단계였던 `DB_CLIENT` 스위치는
없어졌습니다 — 앱은 항상 Prisma 입니다.

**2026-09-28 (2차 · main 반영 2026-10-08)** — 그 scripts/ 의 `.ts` 도구 여섯 개도 Prisma 로 옮기고, 쓰는 곳이 없어진
`lib/db.ts`(627줄)를 지웠습니다. 적용 순서 목록은 `scripts/db-files.mjs` 하나가 됐습니다. 환경 사이에 데이터를
옮기는 `npm run data:release` 도 Prisma 로 새로 만들었습니다(docs/DATA-SOURCES.md). §11. 이 2차는 09-28 에
`portfolio-backend-optimization` 워크트리에서 만들어 미커밋으로 남아 있다가, 10-08 에 그사이 main(디자인 · 배포 ·
모니터링 36커밋) 위로 손으로 옮겼습니다.

측정과 확인은 전부 2026-09-22 에 이 장비에서 한 것입니다.

---

## 0. 30초 요약

| | 상태 |
|---|---|
| SQL 89개(스키마 9 + migrate 80) → `prisma/migrations/` | **됨** (빈 DB 에 `migrate deploy` 성공) |
| `prisma/schema.prisma` (모델 33 · 뷰 2) | **됨** (마이그레이션 결과에서 인트로스펙션) |
| 데이터 계층 121개 쿼리 → Prisma | **됨** — Client API 92 · TypedSQL 9 파일 (§6) |
| 기존 DB 얹기(베이스라인) | **됨** (`npm run db:prisma:baseline`) |
| 두 경로 결과 대조 | **됨** (21개 조회 · 차이 0) |
| 제약 위반 → 4xx 매핑 | **됨** (`lib/pg-errors.ts` 가 세 모양 다 흡수) |
| 실 DB 스모크 | **됨** — 조회 함수 31개 · 개발 DB 사본 · 던짐 0 (`npm run db:prisma:smoke`) |
| PGlite 폴백 | **없어짐** (§5) — DATABASE_URL 필수 |
| 기동 시 마이그레이션 적용 | **없어짐** (§5) — `db:migrate:prisma` 가 배포 순서에 고정 |
| 개발 DB 에 빠졌던 외래키 12개 | **복구 마이그레이션 만듦** — `migrate-080` (§7) |
| 뷰 2개 | 마이그레이션에 **넣지 않음** — 기동마다 재적용 · `npm run db:views` (§2) |

전환 절차만 보려면 §3 으로.

---

## 1. 무엇이 어디에 생겼나

| 파일 | 하는 일 |
|---|---|
| `prisma.config.ts` | Prisma 7 설정. `.env.local` 을 직접 읽습니다 (7 부터 자동 로딩이 없습니다) |
| `prisma/schema.prisma` | 데이터모델. 모델 33 + 뷰 2 |
| `prisma/migrations/**` | `db/*.sql` 89개를 옮긴 것 (생성물 · 뷰는 제외) |
| `scripts/prisma-migrations-build.mjs` | `db/` → `prisma/migrations/` 생성기 |
| `scripts/prisma-baseline.mjs` | 이미 돌고 있는 DB 를 "적용됨" 으로 표시 |
| `scripts/apply-views.mjs` | 뷰만 다시 만듦 (`npm run db:views`) |
| `db/migrate-080-restore-missing-fks.sql` | 개발 DB 에서 사라진 외래키 12개 복구 (§7) |
| `lib/prisma.ts` | 앱의 유일한 DB 진입점 — 클라이언트 싱글턴 · 기동 점검(미적용 경고 · 뷰 재생성) · 쿼리 계측 |
| `prisma/sql/*.sql` | TypedSQL 9개 — 반경 검색·서열표·DB 함수 호출·원자적 UPSERT·수명 삭제·ping |
| `lib/typed-sql/*.ts` | 위 쿼리들의 **생성 모듈을 커밋해 둔 것** — DB 없는 CI·새 설치에서도 타입 검사가 되게 (§10) |
| `scripts/prisma-typed-sql.mjs` | `prisma generate --sql` → `lib/typed-sql/` 복사 · 원본 해시 대조(`--check`) |
| `tests/typed-sql.test.ts` | 원본 `.sql` 을 고치고 다시 만들지 않았으면 실패 (DB 불필요) |
| ~~`lib/db.ts`~~ | ~~scripts/ 전용으로 격하~~ → **2026-09-28 삭제**(main 반영 10-08) — 쓰던 도구 6개를 Prisma 로 옮김 (§11) |
| `lib/data-release.ts` · `scripts/data-release.ts` | 데이터 릴리스 — 외부 원천 데이터를 자연 키로 내보내고 적재 (docs/DATA-SOURCES.md §4) |
| `lib/pg-errors.ts` | 제약 위반 판정이 Prisma 에러 모양도 받음 |
| `tests/prisma-migrations.test.ts` | 폴더가 `db/` 와 어긋나면 실패 |
| `tests/prisma-smoke.test.ts` | 실 DB 스모크 — 조회 함수 31개가 던지지 않고 값을 주는지 (DB 필요 · 기본 건너뜀) |

npm 스크립트: `db:views` · `db:prisma:build` · `db:prisma:check` · `db:prisma:baseline` ·
`db:migrate:prisma` · `db:prisma:drift` · `db:prisma:smoke` · `db:prisma:generate` ·
`db:prisma:studio` · `db:prisma:sql`(DB 필요) · `db:prisma:sql:check`(DB 불필요).

---

## 2. 마이그레이션을 어떻게 옮겼나

**폴더는 손으로 만들지 않습니다.** 적용 순서의 정본은 `scripts/db-files.mjs` 하나이고,
생성기가 그 목록대로 폴더를 찍어 냅니다.

```
db/schema.sql                  → prisma/migrations/20260101000000_schema/migration.sql
db/seed.sql                    → …000100_seed/
…
db/migrate-079-….sql           → …012700_migrate_079_ez2dj_aeic_ae_remix_charts/
db/migrate-080-….sql           → …012800_migrate_080_restore_missing_fks/
db/views.sql                   → (마이그레이션 아님 — 아래 참고)
```

- **합성 타임스탬프**: 원본 파일이 실제로 언제 만들어졌는지는 알 수 없고(커밋 날짜 ≠ 적용
  순서) Prisma 는 이름의 사전순으로만 적용하므로, 2026-01-01 00:00 에서 1분씩 더한 이름을
  씁니다. 뒤에 원본 파일명이 그대로 붙어 있어 어느 파일인지 바로 보입니다.
- **스키마 파일의 `DROP TABLE IF EXISTS` 는 주석 처리합니다.** 그 줄들은 `db:init`(파괴적
  재생성)용입니다. 빈 DB 에서는 결과가 같지만, **베이스라인을 빠뜨린 DB 에 실수로
  `migrate deploy` 를 돌렸을 때** 데이터를 조용히 지우는 대신 "already exists" 로 멈추게
  하려는 것입니다. `migrate-*.sql` 안의 DROP(대부분 그 파일이 만든 임시 테이블)은 그대로 둡니다.
- **시드도 마이그레이션 안에 있습니다.** 지금도 그렇습니다 — 곡·채보·서열표 데이터가
  `migrate-005/033/047/059~079` 에 들어 있어서, 이걸 빼면 새로 만든 DB 가 비어 버립니다.

### 확인한 것

```bash
# 빈 DB 에 89개 전부 적용 — 성공
createdb arcade_finder_prisma_verify
DATABASE_URL=…/arcade_finder_prisma_verify npx prisma migrate deploy
```

`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma` 로
"마이그레이션이 만든 DB" 와 "스키마 파일" 이 같은 것도 확인했습니다.

### 규칙 하나가 늘어납니다

**이미 적용된 마이그레이션의 SQL 은 고칠 수 없습니다.** Prisma 가 적용 시점의 sha256 을
`_prisma_migrations` 에 남기고, 파일이 달라지면 `migrate deploy` 가 거부합니다.
즉 `db/` 의 옛 파일을 고치면 이미 배포된 DB 가 막힙니다. 지금 규칙("적용된 것은 고치지
않고 새 파일을 만든다")과 같지만, 이제는 **도구가 강제**합니다.

새 마이그레이션은 지금처럼 `db/migrate-081-….sql` 을 만들고 `scripts/db-files.mjs` 목록(2026-09-28 부터
이것 하나)에 더한 뒤 `npm run db:prisma:build` 를 돌리면 됩니다. 사용자 데이터 표에 행을 넣으면
안 됩니다 — tests/data-release.test.ts (docs/DATA-SOURCES.md §2).
`npm run db:prisma:check` 가 어긋남을 종료 코드로 알리고, `tests/prisma-migrations.test.ts`
가 같은 것을 테스트에서 잡습니다.

### 뷰는 마이그레이션에 넣지 않았습니다

`db/views.sql` 은 그대로 **기동마다 다시 적용**합니다 (Prisma 경로도 같습니다 — lib/prisma.ts bootChecks).
처음에는 마지막 마이그레이션으로 넣었다가 되돌렸습니다. 두 가지가 깨졌습니다:

1. 뷰는 항상 마지막이어야 하는데(migrate-039 가 만든 `condition_window_days` 를 참조합니다)
   폴더 이름이 순번이라 **새 마이그레이션이 생길 때마다 뷰 폴더 이름이 밀립니다.** 이미
   적용된 DB 에는 옛 이름이 남아 `migrate status` 가 영원히 어긋났다고 말합니다.
2. 집계식 한 줄 고치는 일이 새 마이그레이션 파일을 만드는 일로 바뀝니다. 지금보다 나쁩니다.

뷰는 데이터가 없는 파생 객체라 몇 번을 다시 만들어도 안전합니다. 새 DB 를 만든 직후처럼
앱을 띄우기 전에 뷰가 필요하면 `npm run db:views` 를 쓰세요.

---

## 3. 전환 절차

### 3-1. 이미 돌고 있는 DB (개발·운영)

```bash
npm run db:prisma:build            # 폴더 생성 (이미 생성돼 있으면 "쓴 것 0개")
npm run db:prisma:baseline -- --dry-run
npm run db:prisma:baseline         # _prisma_migrations 에 "이미 적용됨" 표시만
npx prisma migrate status          # → Database schema is up to date!
```

베이스라인은 **DDL 을 한 줄도 실행하지 않습니다.** 무엇이 이미 적용됐는지는 DB 에게
직접 묻습니다 (스키마 그룹 = sentinel 테이블 존재 / `migrate-NNN` = 옛 `schema_migrations`).
그래서 절반만 적용된 DB 도 옳게 얹히고, 나머지는 `prisma migrate deploy` 가 이어서 넣습니다.

확인한 것 (개발 DB 사본 `CREATE DATABASE … TEMPLATE arcade_finder`):

| | 결과 |
|---|---|
| 베이스라인 | 88개 "적용됨" 표시 · `migrate-080` 만 미적용으로 남김 |
| `migrate deploy` | `migrate-080` 하나만 적용 |
| 외래키 | 30 → **42개** (12개 복구 · 전부 `convalidated`) |
| 행 수 | arcades 926 · charts 29,178 · posts 34 — **변화 없음** |
| 옛 경로로 한 번 더 | `npm run db:migrate` 재실행 → FK 42개 그대로 (건너뜀) |

### 3-2. 앱 기동

앱은 **항상 Prisma** 입니다 — 켜는 스위치가 없습니다. 기동 로그에
`[prisma] PostgreSQL 에 붙었습니다 — 뷰 적용 완료` 가 찍히고, 베이스라인·마이그레이션이
빠져 있으면 그 앞에 `[prisma] 마이그레이션 N개가 적용되지 않았습니다` 경고가 찍힙니다
(적용하지는 않습니다 — §5). 새 코드가 새 컬럼을 읽으면 그 자리에서 500 이 되므로 **경고를
보면 멈추고 §3-1 을 먼저 하세요.**

```bash
# 배포 전 실 DB 스모크 (읽기만 합니다 — 사본을 가리키세요)
PRISMA_SMOKE_URL="postgresql://…/사본" npm run db:prisma:smoke
```

`/api/health` 는 `db: { driver: 'postgres', client: 'prisma' }` 를 돌려줍니다. 폴백 상태
(`degraded`)는 폴백이 없어져 사라졌습니다.

### 3-3. 되돌리기

앱 코드를 되돌리는 것(git)입니다 — DB 는 손대지 않았습니다. 옛 `schema_migrations` 테이블을
그대로 두었으므로 옛 코드의 러너가 아무 일 없이 다시 돕니다. `_prisma_migrations` 는 남아
있어도 무해합니다. 이관 중에 새로 넣은 마이그레이션(080 이후)은 옛 목록(`scripts/db-files.mjs`)에도
같은 파일로 들어 있어 양쪽이 같은 DB 를 봅니다.

### 3-4. 새 DB 를 처음부터

```bash
createdb arcade_finder_new
DATABASE_URL=…/arcade_finder_new npx prisma migrate deploy   # 89개 전부
DATABASE_URL=…/arcade_finder_new npm run db:views           # 뷰 2개 (앱이 뜰 때도 만들어집니다)
```

확인한 것: 빈 DB → 표 33 + `_prisma_migrations` · 뷰 2 · 외래키 42 · 채보 15,985행.
`migrate-080` 은 여기서 **아무 일도 하지 않습니다** (스키마 파일이 이미 FK 를 걸어 둡니다).

`npm run db:init` 은 그대로 둡니다 — 옛 경로를 쓰는 사람이 남아 있고, 되돌릴 길이기도 합니다.

---

## 4. 값의 모양이 달라지는 자리 (실측)

같은 SQL 이라도 드라이버 어댑터를 지나면 타입이 달라집니다.

| SQL | node-postgres | Prisma raw | 되돌림 |
|---|---|---|---|
| `int8` (`count(*)`) | `'1'` 문자열 | `1n` BigInt | → 문자열 |
| `numeric` | `'1.5'` 문자열 | `Decimal` | → 문자열 |
| `bytea` | `Buffer` | `Uint8Array` | → `Buffer` |
| `timestamptz` | 정확 | **세션 시간대만큼 어긋남** | 풀을 UTC 로 고정 |

중간 단계(`DB_CLIENT` 스위치)에서는 `normalizeValue` 가 앞의 셋을 되돌렸습니다. 전환을 마친 지금은
그 함수가 없고, TypedSQL 쿼리가 `count(*)::int`·`::float8` 처럼 **SQL 에서 형을 정해** 돌려주며
남는 `Decimal`·`Date` 는 `lib/prisma.ts` 의 `num()`·`iso()` 가 받습니다 (2026-09-28 확인 —
`lib/typed-sql/*.ts` 의 결과 타입에 `bigint` 가 하나도 없습니다). BigInt 가 특히 위험합니다 —
`JSON.stringify` 가 그 자리에서 던지므로 `COUNT(*)` 를 응답에 싣는 라우트가 500 이 됩니다.

**시간대는 정확성 문제입니다.** 드라이버 어댑터를 통한 `$queryRaw` 는 timestamptz 를
세션 시간대의 벽시계로 읽고 UTC 라고 이름 붙입니다. 세션이 Asia/Seoul 이면 모든 시각이
**+9시간** 어긋납니다:

```
pg     : 2026-09-22T08:15:13.633Z   (epoch 차 -0.001초)
prisma : 2026-09-22T17:15:13.681Z   (epoch 차 32399.999초)
```

`lib/prisma.ts` 는 풀을 `options: '-c timezone=UTC'` 로 열어 이 차이를 0 으로 만듭니다.
코드베이스에 `date_trunc`·`to_char`·`::date` 같은 세션 시간대에 기대는 SQL 이 없어
(확인함) 부작용은 없습니다.

### 에러 모양도 다릅니다

제약 위반이 세 가지 모습으로 옵니다. `lib/pg-errors.ts` 가 셋을 다 흡수합니다.

```
node-postgres  { code: '23503', constraint: 'arcade_favorites_player_id_fkey' }
Prisma raw     { code: 'P2010', meta.driverAdapterError.cause:
                 { originalCode: '23503', constraint: { index: '…_fkey' } } }
Prisma Client  { code: 'P2003', meta: { … } }   ·  중복은 P2002
```

흡수하지 않으면 "없는 오락실 담기" 가 404 대신 **500**, 닉네임 중복이 409 대신 500 이 됩니다.

---

## 5. 전환으로 달라진 동작

| | 옛 경로 (lib/db.ts · 2026-09-28 삭제) | 앱 (lib/prisma.ts) |
|---|---|---|
| PGlite 폴백 | 있음 (`.pglite/`) | **없음** — Prisma 7 에 PGlite 어댑터가 없습니다. DATABASE_URL 필수 |
| 기동 시 마이그레이션 | **적용함** (advisory lock) | 적용하지 않음 · 빠진 것이 있으면 경고만 |
| 뷰 재생성 | 기동마다 | 기동마다 (같음 — §2 · advisory lock 도 같은 키) |
| 트랜잭션 제한 시간 | 없음 | 15초 (`PRISMA_TX_TIMEOUT_MS`) |
| 커넥션 풀 | `PG_POOL_MAX` (기본 30) | 같은 값 · 같은 방식 · 세션 시간대 UTC 고정(§4) |
| 쿼리 계측 (Pulse) | `Db` 어댑터를 감쌈 | `$extends` 로 모든 연산 — 지문은 `findMany posts` 꼴, TypedSQL 은 SQL 지문 |
| `/api/health` | healthy · degraded · unhealthy | healthy · unhealthy (`db_primary` 키는 그대로, `db` 와 같은 값) |

앞의 둘은 감출 수 없는 차이라 기동 로그로 드러냅니다. 배포 순서가 **"마이그레이션 먼저,
그다음 기동"** 으로 고정됐습니다 (deploy/README.md §2 · GUIDELINES §3).

왕복 수가 늘어난 자리 — 옛 SQL 은 슬롯 점유 시간을 아끼려고 한 문장에 합쳤던 것입니다.
~~`board.listPosts`(목록 + 고정 공지: UNION ALL 1 → 병렬 2) · `board.getPost`(데이터 변경 CTE 1 →
글 1 + 댓글∥첨부 1)~~ — **이 숫자는 Prisma 연산 수였습니다.** 2026-09-28 에 PostgreSQL 로 나간 **SQL 문장**을
목표 규모 DB 에서 세 보니 `listPosts` 1 → **12**, `getPost` 1 → **9**, 제보 피드 3 → 8 이었습니다 — 기본 관계 로딩이
`include` 한 관계마다 문장을 하나씩 보내기 때문입니다(`IN (…)` 으로 묶어 N+1 은 아님). 앱과 DB 가 한 장비라 호출
시간은 늘지 않았고(글 목록 4.9 → 3.7ms), `relationJoins` 는 깊은 offset 에서 5배 느려져 켜지 않았습니다 —
전후 표와 판단 근거는 [DB-WORKLOAD.md](DB-WORKLOAD.md) §2. 수백 req/s 에 가까워지거나 DB 가 다른 장비로 가면
이 둘이 첫 후보입니다.

---

## 6. ORM·쿼리 빌더로 어디까지 옮길 수 있나 (측정)

`lib/*.ts` 안의 SQL 문 **121개**를 기능별로 갈랐습니다 (2026-09-22 · `db.ts`·`prisma.ts`·
`telemetry.ts` 제외).

| | 개수 | 비율 | 어디 |
|---|---|---|---|
| **A. ORM 으로 그대로** — 단일 표 CRUD | 95 | 78% | auth 25 · board 15 · tier 11 · arcades 9 · reports 9 · emoticons 8 · email-verify 7 · favorites 3 · reviews 3 · rate-limit 2 … |
| **B. 쿼리 빌더 영역** — 조인·집계·ILIKE 검색 | 12 | 10% | tier 3 · arcades 2 · 나머지 각 1 |
| **C. 원시 SQL 이 나음** | 14 | 12% | board 4 · arcades 3 · reports 2 · comments·machine-guess·review-summary·reviews·tier 각 1 |

C 의 내역: haversine 반경 계산 · 뷰 집계(`machine_live`·`cabinet_condition`) · CTE ·
상관 서브쿼리(기종 AND 필터, 목록+총계) · trigram 검색 · `ON CONFLICT … DO UPDATE` 에
`EXCLUDED` 가 여러 번 나오는 복합 upsert.

**답: 된다. 다만 전부는 아니고, 전부일 필요도 없다.** 80% 가까이는 ORM 으로 그대로
옮겨지고, 남는 12%는 어느 도구를 써도 결국 SQL 로 씁니다 — Prisma 는 `$queryRaw`,
Kysely 는 `sql` 태그, Drizzle 은 `sql` 연산자. 즉 **선택은 "SQL 을 쓰느냐 마느냐" 가
아니라 "나머지 80% 를 무엇으로 쓰느냐"** 입니다.

| | ORM (Prisma) | 쿼리 빌더 (Kysely) | 중간 (Drizzle) |
|---|---|---|---|
| 지금 상태 | **깔려 있고 검증됨** (이 문서 전체) | 미도입 | 미도입 |
| 스키마 정본 | `schema.prisma` (인트로스펙션 완료) | TS 타입을 손으로 | TS 스키마를 손으로 |
| 마이그레이션 | `prisma migrate` (이미 89개 이관) | 없음 (별도 도구) | drizzle-kit |
| 원시 SQL 섞기 | `$queryRaw` — 값 모양이 달라짐(§4) | `sql` 태그, 결과 타입 그대로 | `sql` 연산자 |
| 런타임 무게 | 쿼리 컴파일러 포함 | 거의 없음(빌더뿐) | 가벼움 |
| 이 프로젝트에 드는 비용 | 이미 치름 | 스키마 타입 + 마이그레이션 도구를 새로 | 스키마 재정의 + 마이그레이션 재이관 |

**권합니다: Prisma 를 그대로 쓰되, 모듈 단위로 천천히.** 마이그레이션·타입·검증이 이미
끝나 있어 추가 비용이 0 에 가깝습니다. 쿼리 빌더(Kysely)가 더 어울리는 경우는 "SQL 을
그대로 쓰고 싶은데 타입만 받고 싶다" 일 때인데, 그 경우에도 마이그레이션은 여기 만든
Prisma 것을 그대로 쓸 수 있습니다 (`prisma migrate` 는 클라이언트와 독립입니다).

### 결과 — 2026-09-22 오후에 전부 옮겼습니다

측정대로 갔습니다. 배치 원칙 하나: **Prisma Client 로 자연스럽게 표현되면 Client, SQL 자체에
측정 근거나 DB 안의 원자적 의미가 있으면 TypedSQL**. 어느 쪽이든 TS 코드에 SQL 문자열은 없습니다.

| TypedSQL 파일 (`prisma/sql/`) | 왜 SQL 로 남았나 |
|---|---|
| `arcadesWithMachines.sql` | haversine · 낱말 검색 bool_and · 기종 AND 필터 · 뷰 2개를 조인한 json_agg. CTE 집계의 측정 근거(버퍼 44,042 → 163) |
| `tierCharts.sql` | 6단계 정렬 규칙과 인덱스를 타는 레벨 필터 모양 — JS 로 옮기면 규칙이 두 곳 |
| `consumeRateCounter.sql` · `noteLoginFailure.sql` | 조건부 UPSERT 한 문장 = 원자성. Client 의 upsert 는 "창이 지났으면 1, 아니면 +1" 을 못 씁니다 |
| `purgeExpiredQueueReports.sql` | 기준 시각이 **DB 의 now()** 여야 뷰와 어긋나지 않습니다 |
| `recalcChartStats/PostStats/ArcadeRating.sql` | DB 함수 호출 — 집계 규칙은 DB 안에 있습니다 |
| `ping.sql` | /api/health |

나머지(auth 25 · board 15 · tier 11 · reports · emoticons · email-verify · reviews · comments ·
favorites · machine-guess · review-summary)는 Prisma Client 입니다. 옮기면서 같이 고친 것:

- `?machines=1,1` 이 0곳을 내던 버그 — SQL 이 중복을 빼고 셉니다 (실측 3곳 = 3곳)
- 반경 검색이 `arcades_lat_lng_idx` 를 탑니다 — bbox 선필터 뒤 haversine. 결과는 5·30·100km 에서 옛 방식과 **완전히 같음**(실측)
- 목록이 `created_at`·`source` 등 안 쓰는 컬럼 196 KB 를 실어 보내던 것 — 화면이 쓰는 컬럼만
- 제약 위반 매핑: `emoticons_name_key`(부분 인덱스) 위반이 `EmoticonNameTakenError` 로 오는지 실 DB 에서 확인

검증: 단위 테스트 726 통과(대역을 `@/lib/db` → `@/lib/prisma` 로 옮긴 7개 포함) · typecheck 0 ·
`next build` 통과 · 개발 DB 사본에서 조회 함수 31개 스모크(던짐 0 · 데이터 있음 · 원시 컬럼 이름 누출 0).

### 왜 처음엔 한꺼번에 옮기지 않았나

한 번에 옮기면 되돌릴 수 없는 덩어리가 되고, 위 C 14개는 어차피 SQL 로 남습니다.
그래서 오전에는 **엔진만 먼저** 바꿔 두었고, 그 발판(스키마·마이그레이션·에러 매핑·값 모양 실측)이
있어서 오후의 전환이 하루 안에 끝났습니다. 그 상태에서 모듈 하나씩, 쉬운 것부터 옮기면 됩니다
(`getPrismaClient()` 가 같은 커넥션 풀을 씁니다). 권하는 순서:

1. `lib/favorites.ts` (3) · `lib/rate-limit.ts` (2) · `lib/machine-guess.ts` (2)
2. `lib/comments.ts` (4) · `lib/reviews.ts` (6) · `lib/email-verify.ts` (8)
3. `lib/emoticons.ts` (9) · `lib/reports.ts` (12)
4. 나머지는 원시 SQL 로 두는 편이 낫습니다 — 위에 적은 이유로.

예시 (`lib/favorites.ts`):

```ts
// 지금
const { rows } = await db.query<{ arcade_id: number }>(
  `SELECT arcade_id FROM arcade_favorites WHERE player_id = $1
   ORDER BY created_at DESC, arcade_id DESC`, [playerId]);
return rows.map((r) => Number(r.arcade_id));

// Prisma Client
const prisma = await getPrismaClient();
const rows = await prisma.arcade_favorites.findMany({
  where: { player_id: playerId },
  orderBy: [{ created_at: 'desc' }, { arcade_id: 'desc' }],
  select: { arcade_id: true },
});
return rows.map((r) => r.arcade_id);

// ON CONFLICT DO NOTHING ↔ createMany({ skipDuplicates: true })
// DELETE … RETURNING ↔ deleteMany() 의 { count }
```

옮길 때마다 `npm run db:prisma:smoke` 에 그 함수를 한 줄 더하면 두 경로가 계속 대조됩니다.

---

## 7. 개발 DB 가 SQL 파일과 어긋나 있습니다 — 외래키 12개 (복구 마이그레이션 만듦)

이 작업 중에 발견했습니다. `prisma migrate diff` 로 개발 DB 와 "마이그레이션이 만든 DB"
를 비교한 결과입니다.

**개발 DB 에 없는 외래키 12개** — SQL 파일에는 있는데 개발 DB 에만 빠져 있습니다:

```
arcade_favorites  (arcade_id → arcades) · (player_id → players)
arcade_reviews    (arcade_id → arcades)
machine_modes     (machine_id → machines)
machine_reports   (arcade_id) · (cabinet_id) · (machine_id)
player_identities (player_id → players)
posts · songs · tier_grades · tier_settings  (machine_id → machines)
```

`.pglite` → PostgreSQL 이관(2026-09-15) 때 복사 과정에서 빠진 것으로 보입니다
(`scripts/migrate-pglite-to-pg.mjs` 는 복사 중 `session_replication_role=replica` 로
FK 를 꺼 둡니다). **새로 만든 DB 는 정상입니다** — 검증용 DB 에는 12개가 다 있습니다.

영향: 지금은 앱이 무결성을 코드로도 지키므로 조용합니다. 다만 개발 DB 에서는
"없는 오락실 담기" 가 404 가 아니라 **성공**합니다 (FK 가 없어 23503 이 나지 않습니다).
즉 **개발에서 재현되지 않는 운영 버그**가 생길 수 있는 자리입니다.

또 하나: `tier_settings` 에 아무도 읽지 않는 `merge_modes`·`basis_note` 두 컬럼이 남아
있습니다 (SSOT §4.4 에 이미 적혀 있는 잔재).

### 복구 — `db/migrate-080-restore-missing-fks.sql`

외래키 12개는 **복구 마이그레이션을 만들었고, 개발 DB 에 이미 적용됐습니다**
(2026-09-22 17:45 · `schema_migrations` 에 기록). 사본에서 먼저 확인한 뒤(§3-1 표),
이 워크트리에서 `npm run build` 를 돌릴 때 앱의 기동 시 마이그레이션 경로가 집어넣었습니다 —
2026-09-13 부터 서버가 뜨면서 빠진 마이그레이션을 적용하기 때문입니다(GUIDELINES §3).
결과: 외래키 30 → **42개, 42/42 검증됨**, 행 수는 그대로(arcades 926 · charts 29,178 ·
posts 34 · players 16).

> ⚠ **워크트리에 `.env.local` 을 두면 `npm run build`·`npm run dev` 가 개발 DB 를 건드립니다.**
> 빌드가 페이지를 미리 렌더하면서 `getDb()` 를 부르고, 그 자리에서 마이그레이션이 적용됩니다.
> 빌드만 확인하려면 `DATABASE_URL` 을 빈 값으로 두거나(PGlite 로 감) 사본을 가리키세요.

- 그 컬럼에 이미 FK 가 있으면 건너뜁니다. **새로 만든 DB 에서는 아무 일도 하지 않습니다** —
  스키마 파일이 이미 걸어 두기 때문입니다. 옛 경로로 두 번 돌려도 같습니다(확인함).
- `ADD CONSTRAINT … NOT VALID` → `VALIDATE CONSTRAINT` 순서입니다. NOT VALID 도 **새로
  들어오는 행은 곧바로 막습니다**; 기존 행을 훑는 일만 뒤로 미뤄 잠금을 짧게 가져갑니다.
- 고아 행이 있어 검증이 실패하면 경고만 남기고 넘어갑니다 — 마이그레이션을 실패시켜
  배포를 세우는 것보다, 새 쓰기를 즉시 막고 사람이 치우는 쪽이 낫습니다.
  (개발 DB 실측 고아 행: 12개 전부 **0건** → 사본에서 12개 모두 검증까지 통과)

적용하려면 평소대로 둘 중 하나입니다.

```bash
npm run db:migrate            # 옛 경로 (지금 기본값)
npm run db:migrate:prisma     # Prisma 경로 (베이스라인 뒤)
```

남은 잔재 컬럼 2개는 **고치지 않았습니다** — 지우는 것은 되돌릴 수 없고, 아무도 읽지
않는다는 사실만으로 지울 근거가 되지는 않습니다. 어긋남은 언제든 이렇게 다시 잽니다:

```bash
npm run db:prisma:drift     # 종료 코드 2 = 차이 있음
```

복구 뒤 이 명령이 말하는 차이는 `tier_settings` 의 그 두 컬럼뿐입니다(확인함).
옛 이력 테이블 `schema_migrations` 는 일부러 남기는 것이라 `prisma.config.ts` 의
`tables.external` 에 적어 드리프트 검사에서 뺐습니다.

---

## 8. 남은 것

- [x] ~~개발 DB 에 `migrate-080` 적용~~ — 2026-09-22 17:45 적용됨 (FK 42/42 검증)
- [x] ~~`deploy/README.md` 의 배포 순서에 `db:migrate:prisma` 반영~~ — 2026-09-22 (GUIDELINES §3 · README 도)
- [x] ~~모듈별 Prisma Client 이관~~ — 2026-09-22 전부 (§6 결과)
- [x] ~~DB 없는 빌드에서 TypedSQL 모듈이 없어 타입 검사가 깨짐~~ — 2026-09-29 (경위 · 검증 · 버린 대안은 §10). `prisma generate --sql`
      은 DB 에 붙어야 모듈을 만드는데 postinstall(`prisma generate`)·Vercel 빌드는 DB 없이 돕니다.
      생성된 모듈을 `lib/typed-sql/` 로 꺼내 커밋하고, 머리에 원본 sha256 을 적어
      `npm run db:prisma:sql:check` · `tests/typed-sql.test.ts` 가 DB 없이 대조합니다.
      **`prisma/sql/*.sql` 을 고치거나 마이그레이션으로 컬럼 타입이 바뀌면 `npm run db:prisma:sql` 을
      다시 돌리세요** (DB 필요).
- [x] ~~void 를 돌려주는 DB 함수 호출이 던짐~~ — 2026-09-29. `SELECT recalc_x($1) AS done` 은
      드라이버 어댑터가 void 컬럼을 못 읽어 "Failed to deserialize column of type 'void'" 로
      투표·추천·리뷰 저장이 500 이었습니다. `SELECT true AS done FROM (SELECT recalc_x($1)) r` 로.
- [x] ~~Windows 클론에서 마이그레이션 체크섬이 달라짐~~ — 2026-09-29. `.gitattributes` 에
      `prisma/migrations/** text eol=lf`.
- [ ] **개발 DB 베이스라인** — `npm run db:prisma:baseline` 을 아직 안 돌렸습니다. 앱을 띄우면
      "89개 미적용" 경고가 찍힙니다(동작은 됩니다 — 스키마는 이미 최신). 사본에서만 검증했으니
      실제 DB 에는 사람이 한 번 돌리세요 (DDL 0줄 · `--dry-run` 먼저).
- [ ] `tier_settings` 잔재 컬럼 2개를 지울지 결정 (§7)
- [x] ~~`scripts/` 의 적재·점검 도구는 lib/db.ts 그대로~~ — 2026-09-28 `.ts` 여섯 개를 Prisma 로 (§11 · main 반영 10-08).
      `.mjs` 관리 도구(dedupe · sync-news · prune · purge-demo · guess, 호출 45곳)는 아직 원시 SQL
      — 이유는 docs/DATA-SOURCES.md §5
- [ ] `npm run db:init --pglite` · `db:snapshot` · `migrate-pglite-to-pg` 등 PGlite 도구 삭제 여부 — 읽는 곳이
      없습니다 (앱의 폴백은 09-22 에, lib/db.ts 는 09-28 에 사라짐)

---

## 9. 스키마 전수 점검 레시피

"지금 DB 가 마이그레이션이 만드는 것과 같은가" 를 다시 재는 순서입니다. 전부 읽기 전용이고,
섀도 DB 만 새로 만들었다 지웁니다 (**개발·운영 DB 를 섀도로 지정하지 마세요 — 비워집니다**).

```bash
createdb arcade_finder_shadow
export SHADOW_DATABASE_URL="postgresql://…/arcade_finder_shadow"

npx prisma validate                  # 1. 스키마 파일 문법·관계
npm run db:prisma:check              # 2. 마이그레이션 폴더 ↔ db/ 목록
npx prisma migrate status            # 3. 대상 DB 가 어디까지 얹혀 있나
npm run db:prisma:drift              # 4. DB ↔ schema.prisma        (섀도 불필요)
npm run db:prisma:drift:deep         # 5. DB ↔ 마이그레이션 재생 결과 (섀도 사용)
npx prisma migrate diff --from-migrations prisma/migrations \
                        --to-schema prisma/schema.prisma     # 6. 마이그레이션 ↔ schema.prisma

dropdb arcade_finder_shadow
```

Prisma 가 모델 단위로만 보는 것을 넘어서려면 카탈로그를 직접 대조합니다 — 마이그레이션을
재생한 DB 와 실제 DB 의 `information_schema.columns` · `pg_indexes` · `pg_constraint`
(+`convalidated`)를 각각 정렬해 `diff` 하면 됩니다. 뷰는 `pg_get_viewdef` 로 비교합니다
(뷰는 마이그레이션이 아니므로 §2, 위 1~6 에 걸리지 않습니다).

### 2026-09-22 결과

| 점검 | 결과 |
|---|---|
| 1. `prisma validate` | 통과 |
| 2. 폴더 ↔ `db/` | 89개 · 어긋남 0 |
| 3. `migrate status` (개발 DB) | 89개 전부 "미적용" — **베이스라인 전이라 정상** (§3-1) |
| 4. 개발 DB ↔ `schema.prisma` | `tier_settings` 잔재 컬럼 2개뿐 |
| 5. 개발 DB ↔ 마이그레이션 재생 | 같음 (같은 2개뿐) |
| 6. 마이그레이션 ↔ `schema.prisma` | **No difference detected** |
| 7. 재인트로스펙션 ↔ 저장된 스키마 | 차이는 셋 다 의도된 것 — `schema_migrations`(external 선언) · 잔재 컬럼 2개 · 손으로 넣은 뷰 식별자 |
| 8. 뷰 정의 (`pg_get_viewdef`) | 개발 DB = `db/views.sql` 결과 **완전 일치** |
| 9. 카탈로그 전수 (컬럼·인덱스·제약) | 인덱스 87 = 87 · 제약 268 대 267 (차이는 잔재 컬럼의 NOT NULL 하나) · **외래키 42개 전부 일치·검증됨** |

즉 **외래키 복구(migrate-080) 뒤 개발 DB 와 마이그레이션은 잔재 컬럼 2개를 빼면 완전히
같습니다.** 그 2개는 아무 코드도 읽지 않는 옛 흔적이고(SSOT §4.4), 지우는 것은 되돌릴 수
없어 남겨 둡니다.

---

## 10. TypedSQL 은 DB 가 있어야 만들어집니다 — 생성물을 저장소에 둡니다 (2026-09-28)

이관을 이어받아 새 워크트리에서 검증하다 찾았습니다. **CI 가 첫 푸시에 빨간불**이 났을 결함입니다.

| 단계 | 무엇이 도나 | DB |
|---|---|---|
| `npm ci` → postinstall | `prisma generate` — 클라이언트만 | 필요 없음 |
| `prisma generate --sql` | TypedSQL 모듈(`sql/*.ts`) — SQL 을 실제 DB 에 PREPARE 해 타입을 받아 옴 | **필요** |
| CI (`.github/workflows/ci.yml`) | typecheck → test → build | **없음** (Postgres 서비스를 두지 않는 설계) |

생성물이 gitignore(`lib/generated/`) 안에만 있으니, 새로 받은 저장소에서는 `./generated/prisma/sql` 이
없어 **타입 검사 오류 41건**(파일 8개 — 모듈 없음 8건 + 그 여파로 결과가 `unknown` 이 된 자리 33건)으로 멈춥니다
(실측: 이관본 그대로에 `prisma generate` 만 돌린 상태).
이관한 워크트리에는 누군가 한 번 `--sql` 로 만든 파일이 남아 있어서 드러나지 않았습니다.

### 어떻게 풀었나

생성된 TypedSQL 모듈은 `@prisma/client/runtime/client` 하나만 import 하는 **자립형 파일**입니다
(생성된 클라이언트 폴더를 참조하지 않습니다). 그래서 그대로 꺼내 커밋합니다.

```
prisma/sql/tierCharts.sql  ──(npm run db:prisma:sql · DB 필요)──▶  lib/typed-sql/tierCharts.ts  (커밋)
                                                                    // source-sha256: <원본 해시>
```

- 앱은 `./typed-sql` 에서 import 합니다 (`./generated/prisma/sql` 을 더 쓰지 않습니다).
- 모듈 머리에 원본 `.sql` 의 sha256 을 적습니다. **`.sql` 만 고치고 다시 만들지 않으면 실행되는 것은
  옛 SQL** 이라(모듈에 SQL 문자열이 박혀 있습니다) 그걸 DB 없이 잡아야 합니다 —
  `npm run db:prisma:sql:check` 와 `tests/typed-sql.test.ts` 가 해시 · 박힌 SQL 본문 · 목록을 대조합니다.
- 해시가 못 잡는 것: **컬럼 타입이 바뀌어 결과 타입이 달라진 경우.** 마이그레이션을 더한 뒤에는
  `npm run db:prisma:sql` 을 한 번 돌리세요 (DB 에 붙어 다시 만듭니다).

### 검증 (CI 재현)

`.env.local` 을 치우고 `lib/generated/` 를 지운 뒤 CI 와 같은 순서로:

| | 고치기 전 | 고친 뒤 |
|---|---|---|
| `prisma generate` (DB 없음) | 성공 (sql/ 없음) | 성공 (sql/ 없음) |
| `npm run typecheck` | **오류 41건** (파일 8개) | 0 |
| `npm test` | (타입 검사에서 멈춤) | 통과 |

### 버린 대안

| 대안 | 왜 안 했나 |
|---|---|
| CI 에 Postgres 서비스 + `migrate deploy` + `generate --sql` | CI 가 DB 없이 도는 것은 의도된 설계(ci.yml 머리말)이고, 빌드마다 마이그레이션 89개(시드 포함)를 적용하게 됩니다. 로컬에서 새로 받은 사람도 여전히 막힙니다 |
| postinstall 을 `prisma generate --sql` 로 | `npm ci` 가 DB 없이는 실패합니다 — 문제를 옮길 뿐입니다 |
| TypedSQL 을 `$queryRaw` + 손으로 쓴 타입으로 | 결과 타입을 DB 가 보증하지 않게 되고, TS 안에 SQL 문자열이 돌아옵니다(§6 의 원칙과 반대) |

---

## 11. scripts/ 도 Prisma 로 — lib/db.ts 삭제 (2026-09-28)

앱이 Prisma 로 옮겨 간 뒤에도 앱 데이터를 **쓰는** 도구 여섯 개가 옛 어댑터 `lib/db.ts` 로 원시 SQL 을
돌리고 있었습니다. 옛 어댑터는 `DATABASE_URL` 이 없으면 **조용히 `.pglite` 로 내려가** 도구가 "끝났다" 고
말한 뒤 실 DB 에는 아무것도 남기지 않을 수 있었고(lib/script-env.ts 가 경고하던 함정), 스키마가 바뀌어도
원시 SQL 이라 타입 검사가 잡지 못했습니다.

| 도구 | 옮긴 것 | 실행 확인 (개발 DB 사본 · 픽스처 · 외부 API 호출 없음) |
|---|---|---|
| `import-arcades.ts` | 조회 · 삭제 · 찾기(OR) · 갱신 · 삽입 · 출처별 집계 | 새로 1 · 갱신 1 → 다시 돌리면 새로 0 · 갱신 2 |
| `import-charts.ts` | 모드 upsert · 곡/채보 찾고 쓰기 (NULL 이 든 복합 키라 findFirst) | 1회차 새 곡 2 · 새 채보 3 → 2회차 새 곡 1 · 새 채보 2 · 기존 3 · 작곡가 NULL 은 기존 값 유지 · 모드 이름 갱신·순서 유지 |
| `import-localdata-arcades.ts` | 겹침 판정 · 삽입 · 띄어쓰기 통일 | 새로 1 · 기존 행과 같은 곳 1 건너뜀 → 다시 돌리면 새로 0 |
| `verify-arcades-naver.ts` | 조회 · 복구 파일 · 병합 · 삭제 · 집계 | `--report --delete`: localdata 한 곳 삭제 · 복구 파일에 행 전체(17칸) |
| `regeocode-arcades.ts` · `regeocode-building-center.ts` | 조회 · 좌표 갱신 | `--limit 0` 으로 조회 경로까지 (좌표 갱신은 외부 지오코딩이 있어야 돌아 타입 검사로만) |

- 트랜잭션 제한 시간은 `BULK_TX_OPTIONS`(10분 — lib/prisma.ts). 앱의 `TX_OPTIONS`(15초)는 요청 하나 기준이라
  채보 6,000개를 넣는 도구에는 짧습니다.
- PGlite 전용이던 "포트 3000 이 열려 있으면 멈춤" 가드는 뺐습니다 — PostgreSQL 에서는 해당이 없습니다.
- **옮기다 찾은 결함 하나** — `import-arcades.ts` 가 사람이 적어 둔 홈페이지를 빈 문자열로 덮었습니다. 네이버는
  링크가 없으면 `''` 를 주는데 옛 SQL 은 `COALESCE('', homepage)` 라 NULL 이 아니어서 덮었습니다(주석의
  의도와 반대). 빈 값을 "없음" 으로 읽게 고쳤고, 사람이 넣은 값이 남는 것을 픽스처로 확인했습니다.
- `lib/db.ts` 를 지우며 함께 정리한 것: 목록이 두 벌이던 `SQL_GROUPS`·`MIGRATION_FILES`(이제
  `scripts/db-files.mjs` 하나 — tests/db-lists.test.ts 가 db/ 폴더와 대조), 폴백 판정 테스트(db-fallback.test.ts
  6개), 옛 어댑터를 감싸던 `withTelemetry(db)`(lib/telemetry.ts). 테스트 수가 750 → 740 으로 준 것은 이
  때문입니다(지운 코드의 테스트).
- ⚠ 이관 때부터 **풀 대기 지표(`db.wait`)가 비어 있습니다** — 옛 어댑터가 `recordPoolQuery` 를 불렀고,
  Prisma 경로는 연산 단위(`recordOperation`)만 잽니다. 되살리려면 lib/prisma.ts 의 풀을 감싸야 합니다.
- 규칙으로 고정: `scripts/*.ts` 가 `pg` 나 `lib/db` 를 import 하면 tests/architecture.test.ts 가 실패합니다.
