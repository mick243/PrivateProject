# 데이터 성향별 구분과 최적화 판단

> 2026-09-28 작성. 근거는 전부 이 장비에서 잰 것입니다 — 목표 규모 DB(아래 §0) 위에서
> ORM 전환 **전(main 의 원시 SQL)** 과 **후(Prisma)** 를 같은 조건으로 돌렸습니다.
> 규칙은 [GUIDELINES.md](../GUIDELINES.md) 1장 그대로입니다: **목표를 먼저 정하고, 목표 규모 데이터로 잰다.**

---

## 0. 무엇 위에서 쟀나

| | 값 |
|---|---|
| 목표 | 가입자 10,000 · DAU 3,000 · 평시 피크 **3.4 req/s** · 쓰기 **0.062 건/s** · 읽기:쓰기 **54:1** (`load-test/capacity-model.mjs`) |
| 측정 DB | 개발 DB 사본(채보 29,178 · 곡 4,971 · 오락실 926) + `load-test/seed-scale.sql` → 플레이어 10,016 · 글 20,034 · 댓글 20,029 · 클리어 300,280 · 투표 150,178 · 제보 34,163 · 즐겨찾기 15,000 |
| 방법 | `pg.Client.query` 를 감싸 시나리오(= 라우트 한 번이 부르는 lib 함수)마다 **PostgreSQL 로 나간 문장 수**를 세고, 각 문장을 `EXPLAIN (ANALYZE, BUFFERS)` 3회 · 호출 자체를 7회(중앙값) |
| 비교 | 같은 사본을 둘로 떠서(`CREATE DATABASE … TEMPLATE`) 전·후를 따로 — 쓰기 시나리오가 서로의 데이터를 바꾸지 않게 |

⚠ **09-11 의 스케일 DB(`arcade_finder_scale`)는 쓸 수 없었습니다.** 스키마가 마이그레이션 054 에 멈춰 있고,
EZ2DJ 기종 id 가 개발 DB 와 달라(13 대 10) 최신 시드 마이그레이션(059~)이 외래키 위반으로 멈춥니다.
그래서 최신 개발 DB 사본에 시드를 새로 부었습니다.

⚠ **누적 통계(`pg_stat_user_tables`)는 비어 있습니다.** 서버가 2026-09-22 17:44 에 재시작돼
seq_scan·idx_scan·n_tup_* 가 전부 0 입니다. 성향은 아래처럼 부하 모델 · 행 수 · 코드 경로로 갈랐습니다.

---

## 1. 표 35개를 성향으로 가르면

| 성향 | 표 (개발 DB 행 수 → 목표 규모) | 읽기 · 쓰기 | 쓰는 전략 | 상태 |
|---|---|---|---|---|
| **참조(마스터)** | machines 14 · machine_modes 34 · machine_difficulties 4 · game_versions 7 · songs 4,971 · charts 29,178 · tier_settings 3 · tier_grades 20 · board_categories 6 · report_settings 1 · emoticons 3 | 읽기만 · 쓰기는 마이그레이션·관리자 | 프로세스 내 TTL 캐시(`lib/cache.ts`, 5분) + HTTP `private, max-age=300` + ETag/304 (`/api/games`·`machines`·`boards`) | ✅ 적용돼 있음 |
| **위치(준참조)** | arcades 926 · arcade_machines 4 → 3,707 · arcade_cabinets 8 → 11,121 | **모든 세션**이 한 번 읽음(1.9MB) · 쓰기는 관리자·제보 임계값 | CTE 한 번 집계(09-11: 버퍼 44,042 → 163 · 오늘 목표 규모 259) · 응답 압축(→ 122KB) · bbox 선필터 | ✅ · **분리 제안 §3-2** |
| **사용자 생성(OLTP)** | posts 34 → 20,034 · post_comments 29 → 20,029 · post_likes 46 · post_images 2 · arcade_reviews 1 → 6,001 · arcade_favorites 0 → 15,000 · chart_comments 17 · clear_records 280 → 300,280 · difficulty_votes 90 → 150,178 · special_marks 10 | 목록·상세 읽기 · 쓰기 1,245건/일 | 접근 경로 B-tree · **쓰기 시점 집계**(comment_count·like_count·rating_avg·avg_vote 를 DB 함수가 갱신) · 멱등 PUT/DELETE | ✅ · **검색 한계 §3-1** |
| **휘발(TTL)** | machine_reports(대기 4시간) 0 → 34,163 · rate_counters 3 · login_failures 0 · email_verifications 0 | 쓰기가 크기에 비해 잦음 · 시간이 지나면 무효 | 만료 정리 부분 인덱스(migrate-053) · **쓰는 김에 치우기**(rate_counters·login_failures 는 하루 지난 줄을 쓰기 때 삭제) · 캐시 없음 | ✅ 무한 증가 없음 |
| **파생(계산값)** | 뷰 machine_live · cabinet_condition · arcade_review_summaries(AI 요약) · arcade_machine_guesses(AI 추정) · imported_news(외부 동기화) | 읽을 때 계산 / 외부 결과 보관 | 뷰는 기동마다 재생성 · AI 결과는 저장 + 하루 한도 | ✅ |
| **계정** | players 16 → 10,016 · player_identities 2 | 로그인 요청마다 1행 | 세션 확인 = PK 1회(0.02ms) · **일부러 캐시하지 않음**(회수가 즉시여야 함 — GUIDELINES §4-3) | ✅ |
| 운영 메타 | schema_migrations 82 · _prisma_migrations 89 | — | 이관 기간 동안 둘 다 둠 | — |

**이 서비스는 "읽기가 압도적인 OLTP" 입니다.** 그래서 PostgreSQL 하나로 충분하고, 성향별 차이는 DB 를 나누는 것이 아니라
**캐시할지 · 언제 집계할지 · 언제 치울지**로 다룹니다. DB 를 따로 두어야 하는 성향은 지금 하나(검색, §3-1)이고, 둘은 조건부입니다:

| 저장소 종류 | 이 프로젝트에서 맞는 자리 | 지금 필요한가 |
|---|---|---|
| 관계형 OLTP (PostgreSQL) | 참조·위치·사용자 생성·계정 전부 | **씀** |
| 검색 엔진 (OpenSearch+Nori · Meilisearch) 또는 `pg_bigm` | 게시글 검색 — 한글 2글자 | **조건부** (§3-1) |
| 키-값 캐시 (Redis) | 참조 캐시 · 사용량 한도 · 세션 | 장비가 **2대 이상**이 되면 (인스턴스마다 캐시·카운터가 갈림) |
| 지리 (PostGIS) | 반경 검색 | 아니오 — bbox 선필터 뒤 7~14ms (GUIDELINES §2) |
| 벡터 (pgvector) | 챗봇 RAG (`RAG_적용_정리.md`) | RAG 를 실제로 붙일 때 — PostgreSQL 확장으로 먼저 |
| 시계열 · 분석(OLAP) | 제보 이력 분석 | 아니오 — 제보는 4시간 뒤 버려지는 값 |

---

## 2. ORM 전환 전후 — 같은 목표 규모 DB 에서 (2026-09-28)

| 시나리오 | DB 왕복(문장) 전 → 후 | 호출 시간 중앙값 전 → 후 | 메모 |
|---|---:|---:|---|
| `GET /api/arcades` (전체) | 1 → 1 | 69 → 77 ms | TypedSQL — SQL 그대로 |
| `GET /api/arcades` (반경 5km) | 1 → 1 | 13.3 → **7.4 ms** | bbox 선필터가 인덱스를 탐 (버퍼 259 → 163) |
| `GET /api/arcades/:id/reports` | 2 → **7** | 3.3 → 6.5 ms | 관계마다 1문장 (§2-1) |
| `GET /api/reports` (피드) | 3 → **8** | 4.4 → 5.3 ms | 〃 |
| `GET /api/posts` (목록) | 1 → **12** | 4.9 → 3.7 ms | 〃 · 목록 + 고정 공지 2번 × 관계 5개 |
| `GET /api/posts` (offset 4,000) | 1 → 12 | 39 → **7.0 ms** | 쓰는 컬럼만 고르게 바뀌어 버퍼 17,959 → 4,123 |
| `GET /api/posts/:id` | 1 → **9** | 2.6 → 2.8 ms | 〃 |
| `GET /api/tier` (가장 큰 보드 354채보) | 3 → 3 | 6.0 → 7.6 ms | **R14 재측정** — 채보 29,178 · 투표 15만에서도 한 자릿수 ms |
| `GET /api/tier` (펌프) | 3 → 3 | 5.7 → 3.2 ms | |
| `GET /api/charts/:id` | 5 → 7 | 5.4 → 6.2 ms | |
| 세션 확인 (로그인 요청마다) | 1 → 1 | 0.8 → 0.7 ms | |
| 제보 등록 | 7 → 12 | 6.9 → 7.1 ms | |
| 투표 · 추천 · 댓글 · 즐겨찾기 | 3·2·2·1 → 같음 | 0.5~4.2 → 0.9~3.7 ms | **전환본에서는 투표·추천·댓글이 500 이었습니다** (§2-2) |
| 리뷰 | 4 → 8 | 3.4 → 5.8 ms | |

### 2-1. 왕복이 늘었다 — 괜찮은가

Prisma 의 기본 관계 로딩(`relationLoadStrategy: 'query'`)은 `include`·중첩 `select` 한 관계마다 **문장을 하나씩**
보냅니다(`WHERE id IN (…)` 로 묶으므로 N+1 은 아니고 1+K). docs/PRISMA-MIGRATION.md §5 는 이 자리를 "병렬 2왕복" 으로
적었는데 **실측은 12문장**이었습니다 — Prisma 연산 수를 센 것과 SQL 문장 수를 센 것의 차이입니다.

**판단: 지금은 그대로 둡니다.** 배포 구성(deploy/README.md)이 앱과 PostgreSQL 을 **한 장비**에 두어 왕복 하나가
~0.1ms 입니다. 12문장이어도 1ms 남짓이고, 실제로 호출 시간은 늘지 않았습니다(4.9 → 3.7ms).

`relationJoins`(LATERAL JOIN 한 문장)도 켜서 재 봤습니다 — 결과는 **전 시나리오에서 바이트 단위로 같았고**:

| | query(기본) → join |
|---|---|
| 글 목록 · 상세 · 피드 · 제보 목록 | 12→2 · 9→3 · 8→4 · 7→3 문장 |
| 글 목록 offset 4,000 | **11.3 → 60.8 ms** (DB 실행 9.4 → 131ms) — offset 앞의 행에도 관계를 붙입니다 |

그래서 켜지 않았습니다. **다시 볼 조건**: DB 가 앱과 다른 곳으로 가서 왕복이 2ms 를 넘으면(관리형 DB · 서버리스)
`relationJoins` 를 켜고, `board.listPosts` 만 offset 이 클 때 `relationLoadStrategy: 'query'` 로 되돌리세요.

### 2-2. 전환본의 쓰기 결함 — 고쳤습니다

`prisma/sql/recalc*.sql` 이 `SELECT recalc_chart_stats($1) AS done` 꼴이었는데 그 DB 함수들이 **void** 를 돌려주고,
Prisma 드라이버 어댑터는 void 컬럼을 읽지 못해 `Failed to deserialize column of type 'void'` 로 던집니다.
투표 · 클리어 · 특수패턴 · 추천 · 댓글 · 리뷰 저장이 **전부 500** 이었습니다. 타입 생성은 통과했고(`done: string | null`),
단위 테스트는 DB 를 대역으로 세우며, 실 DB 스모크는 조회만 불렀기 때문에 셋 다 지나쳤습니다.

- 고침: `SELECT true AS done FROM (SELECT recalc_chart_stats($1::int)) AS recalc` — 휘발성 함수는 쓰이지 않는 출력이어도
  PostgreSQL 이 지우지 않습니다.
- 재발 방지: `tests/prisma-smoke.test.ts` 에 **TypedSQL 전부를 실 DB 에서 한 번씩(쓰기는 롤백)** 부르는 묶음을 더했습니다.
  옛 SQL 로 되돌리면 정확히 이 메시지로 실패하는 것을 확인했습니다.

---

## 3. 성향 때문에 생긴 한계 두 가지 — 제안

### 3-1. 한글 2글자 검색은 trigram 인덱스를 못 탑니다

| 목표 규모(글 20,034) | 계획 | 실행 | 버퍼 |
|---|---|---:|---:|
| `신발끈` (3글자) | Bitmap Index Scan (title·body trigram GIN) | **0.9 ms** | 11 |
| `신발` (2글자) | **Seq Scan** | **156 ms** | 9,778 |
| `신발` · 제목만 | Seq Scan | 41 ms | 9,778 |

`pg_trgm` 은 LIKE 패턴에서 **세 글자 연속**만 인덱스 조건으로 씁니다. 한국어 검색어는 두 글자가 흔합니다
(펌프 · 공략 · 대회 · 신발 · 후기). GUIDELINES §2 의 "게시글 검색 1.0ms" 는 영문 합성 제목(`loadtest …`)으로 잰 값이라
이 경우를 가리지 못했습니다.

**지금 고치지 않는 이유**: 검색은 세션 경로(JOURNEY)에 없는 드문 동작이고, 목표 규모에서 요청 시간이 126~135ms 로
SLO(p95 < 200ms) 안입니다. 다만 **글 수에 비례해 늘어납니다**(Seq Scan 이라 10만 건이면 ~0.8초로 추정).

| 방법 | 장점 | 비용 |
|---|---|---|
| **바이그램 배열 + GIN** — `search_bigrams text[]`(생성 컬럼) `@>` 검색어 바이그램, ILIKE 로 재확인 | 확장 없이 순수 PostgreSQL · 2글자부터 인덱스 | 생성 컬럼 추가 시 표 재작성 · 인덱스가 본문 길이만큼 큼 · 검색만 TypedSQL 로 |
| `pg_bigm` 확장 | 한중일 2-gram 전용 · LIKE 그대로 | 설치형 확장 — 관리형 DB 는 지원 여부 확인 필요 |
| 검색 엔진(OpenSearch + Nori 형태소) | 형태소 · 오타 · 랭킹 | 운영할 것이 하나 늘고 동기화가 필요 |

**전환 조건**: 글 5만 건, 또는 검색 p95 가 200ms 를 넘으면 첫째 안부터.

### 3-2. `/api/arcades` 는 바뀌는 속도가 다른 데이터를 한 응답에 섞습니다

| 목표 규모 (오락실 926 · 기종 3,707 · 기체 11,121) | 원본 | brotli(q4) | 바뀌는 때 |
|---|---:|---:|---|
| 응답 전체 | 1,876 KB | 122 KB | — |
| 위치 · 기종 · 기체 목록 | 1,131 KB (60%) | 103 KB | 관리자 수정 · 제보 임계값 (하루 몇 번) |
| 기체 컨디션 요약 (30일 창) | 나머지 ≈ 715 KB | — | 컨디션 제보마다 |
| 실시간 대기 (4시간 수명 · 기종 283개) | 30 KB | 4 KB | 몇 분마다 · 시간만 지나도 |

⚠ 컨디션 요약이 기체 11,120대 전부에 붙은 것은 시드가 기체마다 제보 9건을 넣었기 때문입니다 — 실제로는 훨씬 적습니다.

거의 안 바뀌는 목록과 몇 분마다 바뀌는 값이 한 응답이라 **캐시를 걸 수 없습니다** — 어느 오락실에 대기 제보 하나만
들어와도 전체가 다른 응답이 됩니다. 목록을 떼어 ETag/304 로 두고(재방문 시 본문 0), 컨디션·대기는 id 로 짝지은 작은
응답으로 따로 받으면, 재방문 사용자는 **압축 기준 122KB 중 목록 몫 약 100KB 를 아낍니다**(추정 — 압축은 더해지지
않으므로 실제로 나눠 재야 합니다). 휴대폰에서 1.9MB JSON 을 파싱하는 시간도 목록 몫만큼 줄어듭니다.
화면(`ArcadeList` · `ArcadeDetailPanel`)이 `machines[].live` 를 읽으므로 **API 와 화면을 함께 바꾸는 작업**이라
이번에는 설계만 둡니다.

---

## 4. 재 보고 하지 않기로 한 것

| 후보 | 실측 | 판단 |
|---|---|---|
| 인덱스 없는 외래키 6개 (`arcade_favorites.arcade_id` · `post_likes.player_id` · `emoticons.created_by` · `machine_reports.machine_id` · `arcade_machine_guesses.machine_id` · `posts.category`) | 목표 규모에서 **탈퇴 1건 CASCADE 11.4ms**(외래키 트리거 14개 중 최대 1.9ms) · **오락실 삭제 5.2ms**(즐겨찾기 1.5만 행 훑기 1.5ms) | 추가하지 않음 — 부모 삭제가 드물고 인덱스는 쓰기마다 비용. `arcade_favorites` 100만 행이면 다시 |
| 쓰기 경로의 루프 안 쿼리 3곳 (관리자 오락실 수정 · 첨부 연결 · AI 추정 저장) | 관리자·희소 경로 · 피크 쓰기 0.062건/s | 그대로 |
| 서열표 (R14) | 가장 큰 보드 7.6ms · 펌프 3.2ms (채보 29,178 · 투표 15만) | 해소 — 채보가 4배가 돼도 여유 |

⚠ **합성 데이터 착시 하나를 또 찾았습니다.** `seed-scale.sql` 의 `CROSS JOIN LATERAL (SELECT id FROM machines ORDER BY random() LIMIT …)`
이 바깥 행과 상관이 없어 한 번만 평가되고, **926곳 전부가 같은 기종 4개**를 받습니다(arcade_machines 3,707 ≈ 926×4).
그래서 "기종 AND 필터" 가 전부를 돌려주어 그 시나리오의 수치는 **필터가 아무것도 거르지 못하는 최악**입니다.
서브쿼리에 바깥 행을 참조시키면(`WHERE a.id IS NOT NULL` 등) 행마다 평가됩니다 — 기준선이 바뀌므로 고칠 때는
k6 기준선도 다시 재세요.
