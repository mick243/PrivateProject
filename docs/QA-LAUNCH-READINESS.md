# 출시 전 QA 감사 — 남은 일 목록

> 작성 2026-09-13 · 기준 커밋 `fc319d2` (main 과 동일) · 읽기 전용 감사 (코드는 고치지 않았습니다)
> 방법: 코드 정적 검토(보안·운영·프런트 3축) + 이 워크트리에서 `tsc` · `vitest` · `next build` 실행 + 의심 항목은 Node 로 직접 재현.
> 판단 기준은 **"가입자 10,000 · DAU 3,000 규모의 공개 서비스"** 입니다(`GUIDELINES.md` §0).

---

## ✅ 처리 내역 — Blocker 9개 (2026-09-13, 이 브랜치)

| # | 무엇을 했나 | 어디 |
|---|---|---|
| B1 | PostgreSQL 경로도 기동 시 스키마 그룹 → 마이그레이션 → 뷰를 **`pg_advisory_lock` 안에서** 적용. 비파괴 CLI `npm run db:migrate`(`--dry-run` 지원) 추가. SQL 목록을 `scripts/db-files.mjs` 한 곳으로 | `lib/db.ts` · `scripts/migrate.mjs` · `scripts/db-files.mjs` · `GUIDELINES.md` §3 |
| B2 | 폴백 기본값을 **운영에서는 off**. `/api/health` 는 폴백 중 **503** (프록시가 그 인스턴스를 뺌). `start:cluster` 가 `DB_FALLBACK=off` 주입 | `lib/db.ts` · `app/api/health/route.ts` · `scripts/start-cluster.mjs` |
| B3 | systemd unit + 백업 스크립트·타이머 + 복구 절차·출시 체크리스트. `SIGHUP` 무중단 재기동(인스턴스 순차 교체), 내부 포트 루프백 바인딩, GitHub Actions CI(`typecheck → test → build`). 실 DB 를 건드리던 테스트 3건 격리 → 스위트가 DATABASE_URL 없이 631/631 | `deploy/` · `../.github/workflows/ci.yml` · `scripts/start-cluster.mjs` · `tests/` |
| B4 | `/api/chat` 로그인 필수 + 사람당 하루 40회 + 전체 하루 2,000회 (`rate_counters`, migrate-054) | `app/api/chat/route.ts` · `lib/rate-limit.ts` |
| B5 | 있어요/없어졌어요 임계값에 **가입 24시간 미만 계정은 세지 않음**. 운영 필수 env 에 `TRUSTED_PROXY_HOPS≥1` 포함(없으면 기동 거부) | `lib/reports.ts` · `lib/env-check.ts` |
| B6 | 제보 10분 창 제한(로그인 30 · 신뢰 IP 15 · IP 모르면 오락실당 익명 20), 메모 300자 상한(화면·서버 동일 상수), 챗봇 도구 응답에서 메모를 200자로 잘라 `[사용자 메모]` 표시 | `app/api/arcades/[id]/reports/route.ts` · `lib/validation.ts` · `lib/chat-tools.ts` |
| B7 | `/terms` · `/privacy`(운영자 정보는 env — 비면 화면에 경고), 상단 네비 링크, 가입 동의 체크박스(약관·처리방침·만 14세, 서버 `termsAccepted: literal(true)`), **탈퇴 API·UI**(`DELETE /api/account`), 문의·신고 mailto | `app/terms` · `app/privacy` · `lib/legal.ts` · `components/SignupForm.tsx` · `components/AccountForm.tsx` · `app/api/account/route.ts` |
| B8 | `app/error.tsx` · `global-error.tsx` · `not-found.tsx` · `loading.tsx`. 로더 6곳(서열표·커뮤니티·파인더·피드·상세 제보·리뷰)이 `res.ok` 를 보고 화면 안에 문구·재시도 | `app/*.tsx` · `components/*` |
| B9 | 지도 SDK **인증 실패(`navermap_authFailure`)·10초 타임아웃**을 실패로 잡아 FallbackMap 으로 전환(사용자 문구와 개발자 문구 분리). `app/icon.svg` · `robots.ts` · `sitemap.ts` · OG 이미지 · `metadataBase`·title 템플릿. 로그인 설명 "관리자 로그인"·placeholder "관리자" 제거 | `lib/naver-loader.ts` · `components/MapPane.tsx` · `app/layout.tsx` 등 |
| H3 (덤) | 운영 필수 env 를 기동 시 검사해 빠지면 이유를 찍고 종료 (`AUTH_SECRET` · `DATABASE_URL` · `ADMIN_PASSWORD` · `APP_URL` · `TRUSTED_PROXY_HOPS`) | `lib/env-check.ts` · `instrumentation.ts` |
| H5 (덤) | 내부 인스턴스 `-H 127.0.0.1` | `scripts/start-cluster.mjs` |
| 앱(PWA) | 매니페스트·서비스 워커(HTML/API 미캐시, 오프라인 안내)·설치 배너·PNG 아이콘 생성 스크립트·iOS 메타. 실제 Chrome(headless)에서 등록·활성·설치 조건 충족·서버 종료 후 `/offline` 폴백 확인 | `app/manifest.ts` · `public/sw.js` · `components/PwaSetup.tsx` · `docs/PWA.md` |

## ✅ 배포 전 High + 최적화 (2026-09-13)

| 항목 | 전 | 후 |
|---|---|---|
| **H1 오픈 리다이렉트** | `next=/\evil.com` 이 통과해 `https://evil.com/` 로 302. 카카오 로그인을 정상으로 마친 사람이 우리 도메인을 거쳐 남의 사이트에 착지 | 문자를 막는 대신 **URL 로 해석해 출처가 그대로인지** 확인. 브라우저와 같은 파서라 표기 변형이 더 나와도 같은 답. 회귀 테스트 3개 추가 |
| **H2 보안 헤더** | 하나도 없음 (`headers()` 부재, `X-Powered-By` 노출) | CSP · `X-Frame-Options: DENY` · `nosniff` · `Referrer-Policy` · `Permissions-Policy`, `poweredByHeader: false`. CSP 는 프레임·폼·베이스·객체를 닫고 스크립트 출처를 허용 목록으로 |
| **H4 업로드 메모리** | 구간 요청마다 28MB 동영상을 **통째로 메모리에** (`readFile` 후 `subarray`), 크기 검사도 본문을 다 받은 뒤 | `createReadStream` 으로 구간만 스트림. 크기는 `stat` 으로만 확인. POST 는 `Content-Length` 로 **읽기 전에** 거름 |
| **H6 세션 만료 미감지** | 첫 마운트에 한 번만 확인 — 7일 뒤 닉네임은 남고 쓰기만 401 | 탭으로 돌아올 때(`visibilitychange`·`focus`) 1분 간격으로 재확인. fetch 40여 곳을 감싸는 대신 실제로 겪는 경우를 덮음 |
| **P1 접근성** | 목록 줄이 마우스 전용 (`<li onClick>`). 지도 마커가 보조기술 접근 불가라 목록이 유일한 대체 경로 | 제목이 **진짜 버튼**. 줄 클릭은 마우스 편의로 유지. 오락실·글 목록 양쪽 |
| **모바일 `100vh`** | iOS 주소창만큼 하단이 잘림 | `100dvh` 를 뒤에 덧대 폴백 유지 |
| **캐시 헤더 (최적화 1순위)** | 34개 중 33개가 `force-dynamic`, 캐시 헤더 0 | 참조 데이터 3개(`/api/machines` · `/api/boards` · `/api/games`)에 `private, max-age=300` + **ETag**. `If-None-Match` 로 **304 · 0바이트** 확인. 세션에 따라 달라지는 `/api/tier` 는 제외 |
| **에디터 번들** | 글을 읽기만 해도 Tiptap 을 내려받음 | `dynamic(ssr:false)` 로 글쓰기를 열 때 받음 |
| **탈퇴용 인덱스** | `player_id` 인덱스가 6개 표 중 2개 | `migrate-056` 으로 **8개**. 탈퇴 한 번이 표마다 순차 스캔하던 것을 없앰 |

**CSP 에서 배운 것**: 처음에 운영 기준으로만 쓰고 넣었더니 `npm run dev` 가 깨졌습니다. React 개발 빌드가 `eval` 을 쓰고 HMR 이 WebSocket 을 씁니다. **운영에 나가는 값은 그대로 두고 개발에서만** `'unsafe-eval'` 과 `ws:` 를 더합니다 — 빌드 산출물(`routes-manifest.json`)로 확인했습니다.

**아직 확인 못 한 것**: 네이버 지도 SDK 가 CSP 아래에서 도는지. 로컬에 지도 키가 없어 대체 지도로만 떠서 실제 SDK 를 테스트하지 못했습니다. 키를 넣고 여는 날 콘솔에 CSP 위반이 없는지 확인해야 합니다 (체크리스트에 넣었습니다).

**~~미룬 것~~ → H12 토큰 회수도 고쳤습니다 (2026-09-13, 출시 전)**: `players.token_epoch` 한 컬럼(`migrate-057`)을 토큰에 함께 봉하고 요청마다 대조합니다. 예상대로 `getSession`·`sessionPlayerId`·`requirePlayer` 가 async 가 되어 **라우트 19개 · 호출 31곳**이 `await` 로 바뀌었습니다. 대신 얻은 것이 셋입니다 — 비밀번호를 바꾸면 다른 기기 세션이 끊기고, 탈퇴한 계정의 쿠키가 즉시 죽고, 권한 회수가 다음 요청에 반영됩니다. 세션마다 DB 를 보게 되면서 `adminRow` 와 `/api/auth/session` 의 중복 조회가 사라져 **관리자 경로는 조회가 2회에서 1회로 줄었습니다.** `tests/session-revoke.test.ts` 10개가 지킵니다.

---

## ✅ UX 후속 2 — 데이터 노출 · 표기 · 터치 · 로그인 벽 (2026-09-13)

| 항목 | 전 | 후 |
|---|---|---|
| 카드에 수집 메타데이터 | 939곳 중 **524곳**의 카드에 `네이버 지역 검색 · 스포츠,오락>오락실 · https://…utm_source=qr` 이 원본 그대로 세 줄 | `migrate-055` 로 `homepage` 칸을 만들어 주소를 옮기고 출처 문자열은 비움. 화면에는 **홈페이지 · SNS** 링크 하나. 수입 스크립트도 더 이상 메모에 쓰지 않음 |
| `영업시간 미등록` 반복 | 목록 열 줄이 모두 같은 말 (영업시간이 있는 곳은 1곳) | 목록에서는 **모르면 줄을 그리지 않음**. 대신 **상세에 영업시간 칸을 새로 만들어** '정보 없음' 까지 알려 줌 (전에는 상세에 칸 자체가 없었음) |
| 중복 오락실 | 같은 가게가 이름만 달리해 두 번 (`고고오락실` / `고고오락실 대실역점`, 같은 주소) | `npm run arcades:dedupe` 추가. **확실 12쌍을 합쳤고**(939 → 927곳) 제보·리뷰·즐겨찾기·기종·기체를 남는 행으로 옮김. 판단이 필요한 7쌍은 목록만 출력하고 건드리지 않음 |
| 시드 글이 진짜 글처럼 | "테스트", "이번 달 지역 대회 정보 (가상)" 등이 목록 상단에 | `npm run db:purge-demo` 추가. **제목을 시드 SQL 파일과 대조**해 고름(낱말 추측 아님) — 30개 중 28개가 시드. **적용은 하지 않음**(운영 전 결정 사항) |
| 기종 이름 표기 | 필터 칩은 `사볼`, 제보 드롭다운은 `SOUND VOLTEX` — 14종 전부 두 표기 | 드롭다운을 `사볼 · SOUND VOLTEX` 로. 칩에서 고른 이름으로 바로 찾을 수 있음 |
| 모바일 터치 타깃 | 375px 화면에서 **40px 미만 78개**, 기종 칩 28px · 햄버거 32px · 지도 마커 9px | `@media (pointer: coarse)` 에서 칩·작은 버튼·별·햄버거를 40px 로, 마커는 보이는 크기를 그대로 두고 **투명 히트 영역**을 ±14px. 58개로 감소(남은 것은 인라인 링크와 39px 입력칸) |
| 챗봇 로그인 벽 | 질문을 다 쓰고 **보낸 뒤에야** 401. 게다가 "오락실 탐색은 로그인 없이 됩니다" 라고 하면서 방금 보낸 오락실 검색을 거절 | 입력창 위에 상시 안내 + **로그인 링크**. 로그아웃 상태의 자유 질문은 서버까지 가지 않고 그 자리에서 답함. placeholder 도 할 수 있는 것만 보여 줌 |
| 죽은 '글쓰기' 버튼 | 비로그인에 회색 비활성 버튼 (이유는 툴팁에만 — 폰에는 툴팁이 없음) | **`로그인하고 글쓰기` 링크** → `/login?next=/community` |
| "로그인하면 …" 안내 | 문구만 있고 갈 길이 없음 (리뷰·채보 평가·댓글) | 셋 다 로그인 링크로 |

**일부러 안 한 것**
- **판단 필요 7쌍**은 합치지 않았습니다. `연남점` 과 `연남2호점` 은 36m 떨어진 **다른 가게**이고, 잘못 합치면 한 곳이 지도에서 사라집니다. 목록을 사람이 30초 보면 끝나는 일이라 그쪽에 남깁니다 — `npm run arcades:dedupe -- --include-unsure --apply`.
- **시드 글 삭제**는 적용하지 않았습니다. 지우면 게시판이 공지 1개만 남습니다. 개발 중에는 필요한 내용이라 운영 배포 직전에 한 번 도는 것이 맞습니다 (deploy/README.md 체크리스트).
- **사이드바 기본 접힘**과 **기본 정렬(평점순)** 은 코드에 근거가 적힌 제품 결정이라 손대지 않았습니다. 다만 평점이 0건인 동안 '평점 높은 순' 은 사실상 이름순이라, 출시 전에 다시 볼 값입니다.

---

## ✅ UX 후속 — 빈 상태 문구 · 뒤로가기 (2026-09-13)

실제로 화면을 눌러 본 뒤(사용자 관점 점검) 가장 컸던 두 가지를 고쳤습니다.

**빈 상태 문구** — 크라우드소싱 서비스에서 빈 화면은 "아직 아무도 안 알려 줬다" 는 뜻인데, 화면은 그 말을 하지 않고 비어만 있었습니다.

| 어디 | 전 | 후 |
|---|---|---|
| 오락실 목록 (기종 필터 0곳) | `emptyMessage={null}` — **아무것도 안 그림**. "화면 안 0곳" 한 줄이 전부 | "**IIDX** 보유 오락실이 아직 없습니다" + 제보로 채워진다는 설명 + **기종 필터 끄기** 버튼 |
| 오락실 목록 (그 밖의 0곳) | 같음 (침묵) | 검색·화면 밖·빈 지역을 나눠서 다른 말. 이유별 문구를 `listEmptyState` 한 곳에서 만듭니다 |
| 실시간 제보 | "해당 조건의 제보가 없습니다" (조건을 건드린 적도 없는데) | 기간이 기본값이면 "최근 24시간 안에 …기간을 '전체' 로", 전체인데도 없으면 "아직 올라온 제보가 없습니다 …알려 주시면 여기에 바로 뜹니다" |
| 서열표 | 등급 8칸이 전부 "0곡" 인데 레벨 선택은 "S1 · 18곡" — **같은 화면에서 모순** | "아직 투표가 모이지 않아 등급에 놓인 채보가 없습니다. 이 구간의 17곡은 모두 아래 '미정' 에 있습니다" |
| 오락실 상세 | "등록된 기종이 없습니다." | "아직 등록된 기종이 없습니다. 이곳에서 본 기종을 아래에서 골라 알려 주세요." (바로 아래가 제보 칸) |

조사는 이름 뒤에 붙이지 않습니다 — `펌프가` / `츄니즘이` 가 받침에 따라 갈리고 `IIDX` 는 규칙이 서지 않아, 뒤에 명사(`보유 오락실이`)를 두어 어떤 이름이 와도 문장이 맞게 했습니다.

**뒤로가기** — 상세를 열어 둔 채 뒤로가기를 누르면 패널이 닫히는 게 아니라 **사이트를 벗어났습니다.** 안드로이드와 설치형 앱에서 주된 조작이라 자주 겪습니다. 커뮤니티는 이미 `pushState` 로 같은 문제를 풀고 있어 두 화면이 서로 다르게 움직였습니다.

- 상세를 열면 히스토리 한 칸을 쌓고 주소에 `?arcade=<id>` 를 남깁니다. **덤으로 링크 공유·북마크가 됩니다** — 실시간 피드는 이미 `/?arcade=3` 으로 넘어오는데 정작 그 주소를 만들 방법이 없었습니다.
- 오락실을 **바꿀 때는 쌓지 않고 갈아끼웁니다**(replace). 목록을 훑는 화면이라 누를 때마다 쌓으면 뒤로가기를 스무 번 눌러야 목록으로 돌아갑니다.
- 인앱 '닫기' 도 `history.back()` 을 거칩니다 — 뒤로가기와 완전히 같은 경로를 지나야 히스토리 깊이가 눈에 보이는 이동 횟수와 어긋나지 않습니다.
- 딥링크로 들어온 첫 칸에서 '닫기' 는 칸을 쌓지 않고 주소만 정리합니다.
- `pushState`/`replaceState` 의 state 로는 `null` 만 넘깁니다 (Next 공식 사용법). 우리 값을 넣으면 라우터 내부 상태를 덮어써 뒤로가기 때 페이지가 통째로 다시 마운트됩니다.

브라우저로 확인한 것: 열기 → 주소에 `?arcade=` · 히스토리 +1 / 다른 곳으로 전환 → 주소만 바뀌고 히스토리 그대로 / 뒤로가기 → 패널만 닫히고 **사이트에 남음** / 앞으로가기 → 같은 곳 다시 열림 / 딥링크 진입 후 닫기 → 주소만 정리 / 다른 탭(`/live`) 왕복 후에도 라우터 정상.

---

검증: `tsc` 통과 · `vitest` 29파일 **631/631**(DATABASE_URL 없이) · `next build` 통과(51 라우트) · 개발 PostgreSQL 에 대해 기동 경로가 053·054 를 advisory lock 안에서 실제 적용하고 카운터가 2회 허용/3회째 거절함을 확인. 개발 DB 는 적용 전 `pg_dump` 로 떠 두었습니다.

**남은 결정**: `/terms`·`/privacy` 조항 검토(법률 자문 대체 아님), `NEXT_PUBLIC_OPERATOR_NAME`·`NEXT_PUBLIC_CONTACT_EMAIL` 채우기, 복구 리허설 1회, H1(오픈 리다이렉트)·H2(보안 헤더)부터 High 항목.

---

## 0. 한 장 요약

**지금 상태**: 기능 4축은 전부 동작하고, 인가·XSS·SQL 인젝션·업로드 판별·부하는 견고합니다. 빌드·타입체크는 통과합니다.
**그런데 "공개 서비스" 로서 빠진 것**이 세 묶음 있습니다.

| 묶음 | 왜 출시를 막는가 | 대표 항목 |
|---|---|---|
| **① 운영 배포 경로가 없다** | PostgreSQL 에 마이그레이션을 **비파괴로** 적용하는 도구가 없고, DB 폴백이 운영에서 기본 ON, 프로세스 관리자·백업·CI 가 0 | B1 · B2 · B3 |
| **② 비용·조작 표면이 열려 있다** | 챗봇이 무인증·무제한, 프록시 없으면 가입 제한 0 → 계정 2개로 오락실 기종 조작 | B4 · B5 · B6 |
| **③ 사용자에게 보이는 껍데기가 없다** | 약관·개인정보처리방침·운영자 표기 0건, 에러/404 화면 없음, favicon 없음, 지도 인증 실패가 빈 화면 | B7 · B8 · B9 |

**Blocker 9개 · High 12개 · Medium 15개 · Low 12개.** Blocker 는 전부 하루 이내 작업량이고, 코드보다 **운영 절차와 문서** 쪽이 많습니다.

---

## 1. 이번에 직접 확인한 것

| 확인 | 결과 |
|---|---|
| `npx tsc --noEmit` | ✅ 통과 |
| `next build` (Turbopack, 실제 node_modules 사본) | ✅ 통과 — 47 라우트 |
| `vitest run` — 28파일 615 테스트 | ⚠ **612 통과 · 3 실패** — 실패 3건은 전부 5초 타임아웃. 원인은 코드 결함이 아니라 **테스트가 실 DB 를 건드리기 때문**입니다 (아래 T1) |
| `safeNext` 오픈 리다이렉트 | ❌ **재현됨** — `next=/\evil.com` 이 통과해 `https://evil.com/` 으로 302 (아래 H1) |
| PostgreSQL 부팅 시 마이그레이션 | ❌ **안 돕니다** — `runMigrations` 호출은 PGlite 경로에만 있음 (아래 B1) |
| 워크트리 미커밋 작업 | ⚠ `mfa-jwt-token-status` 에 **이메일 인증 기능 일체(50여 파일)** 가 커밋 없이 방치 (아래 P1) |

---

## 2. Blocker — 이것 없이는 열 수 없다

### 운영 배포 경로

**B1. PostgreSQL 에 마이그레이션을 비파괴로 적용할 방법이 없다**
- `lib/db.ts:194` — `runMigrations(db)` 와 `views.sql` 적용은 `createPgliteDb()` 안에만 있습니다. `createPgDb()`(`lib/db.ts:69`) 는 풀만 만들고 스키마를 건드리지 않습니다.
- 운영 PG 에 스키마를 넣는 유일한 코드 경로는 `scripts/init-db.mjs` 인데, 이것은 `db/schema.sql:14-17` 의 `DROP TABLE … CASCADE` 를 먼저 실행하는 **파괴적** 스크립트입니다. 개발 DB 의 052·053 은 누군가 psql 로 손수 넣은 것입니다(`GUIDELINES.md` §6 도 "어느 브랜치에도 커밋되지 않은 마이그레이션이 적용돼 있다" 고 자백).
- 문서(`GUIDELINES.md` §3 "마이그레이션에 잠금이 없습니다 — 두 인스턴스가 동시에 적용하면…") 는 부팅 시 적용되는 것처럼 서술돼 있어 **문서와 코드가 어긋납니다.**
- 결과: 출시 후 첫 스키마 변경을 반영할 수단이 "DB 초기화" 밖에 없습니다.
- 수정: `scripts/migrate.mjs`(비파괴 · `schema_migrations` 기준 · `pg_advisory_lock` 감싸기) 를 추가하고 배포 절차에 명시. 또는 `createPgDb` 뒤에도 같은 러너를 붙이되 advisory lock 필수.

**B2. 운영에서 PGlite 폴백이 기본 ON — 조용한 스플릿 브레인**
- `lib/db.ts:335` `DB_FALLBACK !== 'off'` 가 기본. `scripts/start-cluster.mjs` 는 `NODE_ENV=production` 은 넣지만 `DB_FALLBACK=off` 는 넣지 않습니다.
- Postgres 가 잠깐 끊기면 그 프로세스는 **수명 내내** 로컬 `.pglite/` 에 씁니다. 스냅샷이 없으면 **시드 데이터(가상 오락실 5곳 · 가상 사용자 12명)로 새 DB 를 만들어** 서비스합니다(`lib/db.ts:183-191`, `db/seed*.sql`). 인스턴스 2개는 같은 `.pglite/` 를 못 열어 한쪽은 503, 한쪽은 사본에 글·제보가 쌓입니다.
- `/api/health` 는 이때 **200 `degraded`** 를 돌려주고(`app/api/health/route.ts:40,53`) 클러스터 프록시는 200 이면 트래픽을 계속 보냅니다(`start-cluster.mjs:121`).
- 수정: `NODE_ENV=production` 이면 폴백 기본 off, `DATABASE_URL` 없으면 기동 실패. degraded 는 503 또는 프록시가 `status==='healthy'` 만 인정.

**B3. 배포·프로세스 관리·백업·CI 산출물이 하나도 없다**
- Dockerfile · compose · systemd · pm2 · Procfile · `.github/` 전부 없음(저장소 루트와 상위 모두).
- `scripts/start-cluster.mjs` 가 유일한 기동기: SIGTERM 시 자식 전부 동시 종료(`:216-227`) → **무중단 재시작 없음, 배포 = 전체 다운.** 로그는 `stdio: inherit` 콘솔에만 → 로테이션·보존 없음. 자신이 죽으면 살려 줄 상위 관리자 없음.
- 백업: 문서에 있는 것은 부하테스트용 `pg_dump` 메모뿐. 주기·보존·**복구 리허설**·업로드 디렉터리(`uploads/posts/`, DB 밖 파일) 백업 언급 없음.
- CI: `typecheck && test && build` 를 자동으로 돌리는 곳이 없음. 이번에 실패한 테스트 3건도 그래서 아무도 못 봤습니다.
- 수정: systemd unit(또는 pm2) + 로그 로테이션 + 순차 재기동 명령, `pg_dump` cron + `uploads/` 동기화 + 복구 절차를 README "운영" 절로, GitHub Actions 최소 1개.

### 비용·조작 표면

**B4. `/api/chat` 이 무인증·무제한으로 Gemini 를 부른다**
- `app/api/chat/route.ts` 에 `requirePlayer` / `sessionPlayerId` / 시도 제한 전부 없음. 요청 1건 = 최대 8회 모델 호출(`MAX_ITERATIONS`) + 매 호출 `googleSearch` 그라운딩, 입력은 턴 24 × 4,000자(`lib/validation.ts:409-424`), `maxDuration = 120`.
- 스크립트 하나로 API 청구가 폭발합니다. 키가 유출된 것과 비용 영향이 같습니다.
- 수정: 로그인 요구 + `login_failures` 와 같은 DB 카운터로 사용자/일 한도 + 전역 일일 예산 캡(초과 시 503).

**B5. 프록시 없는 배포에서는 가입 제한이 0 → 계정 2개로 오락실 기종 조작**
- `lib/auth.ts:795-797` — `TRUSTED_PROXY_HOPS` 기본 0 이면 `clientKey` 가 null, `app/api/auth/signup/route.ts:43-45` 는 그때 **제한을 건너뜁니다**(주석에 "가입 제한이 없습니다" 명시).
- `lib/reports.ts:110` 보유 반영 임계값이 **서로 다른 계정 2명**. 즉 일회용 계정 2개면 임의 오락실의 기종을 넣고 뺄 수 있습니다(`arcade_machines` 변경). 지도의 핵심 데이터가 근거부터 오염됩니다.
- `start:cluster` 만 홉 1 을 자동 주입합니다. 단일 `next start` 나 PaaS 직배포는 그대로 노출.
- 수정: 배포 체크리스트에 홉 수 강제 + 가입에 IP 외 근거(이메일 인증 — P1 의 미커밋 작업이 바로 이것) + 임계값 판정에 계정 연령 조건.

**B6. 익명 제보가 무제한·무길이**
- `app/api/arcades/[id]/reports/route.ts:44-73` — 세션 없이 201, 어떤 키로도 세지 않음. `comment` 는 `optionalText` 에 `.max()` 없음(`lib/validation.ts:26-31`) → DB `TEXT` 에 무제한.
- 그 `comment` 가 `/live` 전국 피드에 그대로 뜨고(`LiveFeed`), 챗봇 도구 응답에도 실립니다(`lib/chat-tools.ts:124`) → 간접 프롬프트 인젝션 + 컨텍스트 비용 증폭.
- 수정: `comment.max(300)`, 오락실+기종당 쿨다운(DB 카운터), 도구 응답에서 200자 절단. 익명 허용 자체는 유지(설계 의도).

### 사용자에게 보이는 껍데기

**B7. 법적 고지 전무 — 약관·개인정보처리방침·운영자 표기·문의/신고 채널 0건**
- `grep 약관|개인정보처리|privacy|terms|위치정보|14세` → 앱 코드 0건. 전역 푸터 없음(`app/layout.tsx`).
- 닉네임·비밀번호·소셜 식별자·이메일(`lib/auth.ts:510-515`)을 저장하므로 처리방침 게시 의무. **카카오·네이버 OAuth 앱 심사가 처리방침 URL 을 요구**하므로 이것 없이는 소셜 로그인 자체가 운영 승인을 못 받습니다. GPS `watchPosition`(`lib/use-live-location.ts:94`) 사용 → 위치정보 이용 고지. 만 14세 미만 처리 없음. **회원 탈퇴 API 없음**(`app/api/account` 에 DELETE 없음).
- 수정: `/terms` · `/privacy` 페이지 + 푸터 링크, 가입 폼 동의 체크박스, 탈퇴 API, 신고 버튼(최소 mailto).

**B8. 에러 바운더리·404·loading 없음 — API 500 이 흰 화면으로**
- `app/error.tsx` · `global-error.tsx` · `not-found.tsx` · `loading.tsx` 전부 없음.
- 500 응답에 `data.games` 가 undefined → `games.map` 크래시(`components/TierBoardView.tsx:80-83`), 커뮤니티 목록도 동일(`CommunityView.tsx:209-226`). `ArcadeFinder.tsx:296-308` 의 `fetchArcades` 는 catch 없음 → 조용히 이전 목록 유지.
- 배포 순단·DB 커넥션 이슈가 곧 "Application error" 화면입니다.
- 수정: `app/error.tsx`(재시도) · `not-found.tsx` · `loading.tsx`, 각 로더에 `if (!res.ok) throw` + 화면 내 `.warn`.

**B9. 네이버 지도 인증 실패가 조용히 빈 지도로 끝난다 (+ favicon·robots·OG 없음)**
- `lib/naver-loader.ts:37-46` 은 `onload/onerror` 만 봅니다. **도메인 미등록·키 오류 시 SDK 는 200 으로 로드되고 `naver.maps` 도 존재**하므로 resolve 됩니다. 네이버가 실패를 알리는 `window.navermap_authFailure` 는 정의된 곳 없음(grep 0건). `MapPane.tsx:80` 은 키 **유무**로만 `FallbackMap` 분기.
- 출시 당일 가장 흔한 사고("NCP 콘솔에 운영 도메인 안 넣음")가 회색 빈 지도로 나타납니다.
- `public/` 디렉터리 자체가 없어 `/favicon.ico` 가 매 방문 404. `robots.ts` · `sitemap.ts` · `openGraph` · `metadataBase` 없음. `/login` 의 description 이 `'관리자 로그인'`(`app/login/page.tsx:6`), 로그인 폼 placeholder 가 `"관리자"`(`LoginForm.tsx:127`).
- 수정: 로더에 `navermap_authFailure` → reject + 10초 타임아웃 → `FallbackMap` 전환; `app/icon.png` · `robots.ts`(`/api/`, `/account` disallow) · `sitemap.ts` · OG 이미지.

---

## 3. High — 출시 첫 주 안에

**H1. OAuth 로그인 뒤 오픈 리다이렉트 — 재현됨**
- `lib/auth-types.ts:49-52` `safeNext` 는 `/` 로 시작하고 `//` 가 아니면 통과. `/\evil.com` 이 통과합니다.
- `callback/route.ts:91-93` `new URL(landing, request.url)` — WHATWG URL 은 `\` 를 `/` 로 취급해 **`https://evil.com/`** 이 됩니다(Node 로 확인).
- `/api/auth/oauth/kakao?next=/\evil.com` 링크 → 정상 카카오 로그인 → 우리 도메인 302 로 공격자 사이트. 로그인 직후 피싱에 최적.
- 수정: `safeNext` 에 `raw.includes('\\')` 거부 또는 `new URL(raw,'http://x').origin==='http://x'` 판정. `tests/oauth.test.ts` 에 케이스 추가.

**H2. 보안 헤더 전무** — `next.config.mjs` 에 `headers()` 없음, `poweredByHeader` 미설정, `middleware.ts`/`proxy.ts` 없음. CSP · `X-Frame-Options`/`frame-ancestors` · HSTS · `nosniff` · `Referrer-Policy` 0. 관리자가 로그인한 채 외부 페이지가 `/` 를 iframe 으로 덮으면 클릭재킹. 수정: `headers()` 한 블록.

**H3. 필수 환경변수 검증이 한 곳에 없다 — 전부 요청 시점에 터진다**
- `AUTH_SECRET` 없음 → 쿠키 있는 사용자·로그인만 500(`lib/auth.ts:90-103`). `ADMIN_PASSWORD` 없음 → **일반 로그인까지 503**(R11, `app/api/auth/login/route.ts:64-69` 여전히 존재). `APP_URL` 없음 → 프록시 뒤 OAuth 콜백 불일치. `NEXT_PUBLIC_NAVER_MAP_KEY_ID` 없음 → 조용히 FallbackMap.
- 수정: `instrumentation.ts register()` 에서 운영 필수값 검사 후 `process.exit(1)`; R11 검사는 관리자 닉네임 분기 안으로.

**H4. 업로드 메모리 DoS** — `app/api/uploads/route.ts:39` `formData()` 가 본문 전체를 메모리에 올린 **뒤** `:52` 에서 크기를 봅니다. 읽기도 Range 요청마다 `fs.readFile` 전체(최대 50MB) 후 `subarray`(`[id]/route.ts:31,54`). 동영상 seek 한 번 = 50MB. 수정: `Content-Length` 선제 거절 + `createReadStream({start,end})`.

**H5. 내부 인스턴스 포트가 모든 인터페이스에 바인딩** — `start-cluster.mjs:75` 에 `-H 127.0.0.1` 없음. 3001/3002 로 직접 붙으면 `X-Forwarded-For` 를 공격자가 통제해 홉 신뢰가 무력화됩니다. 수정: `-H 127.0.0.1` + 방화벽.

**H6. 세션 만료를 클라이언트가 감지하지 않는다** — `lib/use-session.ts:70-72` 는 마운트·로그인·로그아웃 때만 갱신. 7일 뒤 네비엔 닉네임이 남고 글쓰기 버튼도 활성인데 모든 쓰기가 401. 즐겨찾기는 401 을 **아무 말 없이 되돌립니다**(`use-favorites.ts:140-146`). 글 작성 중 401 → 로그인 이동 시 본문·첨부 전부 소실. 수정: 공용 `apiFetch` 에서 401 → 세션 null + 토스트 + `next` 링크, PostForm 본문 `sessionStorage` 자동 저장.

**H7. 헬스체크가 `SELECT 1` 만** — 업로드 디렉터리 쓰기 가능 · 디스크 여유 미검사(`health/route.ts:27-30`). degraded 가 200(B2). `version` 은 `APP_VERSION` 없으면 `'dev'`. 수정: `checks.uploads_writable`, `checks.disk`, degraded → 503.

**H8. 데이터 준비도 — 기종 데이터가 사실상 없다** (SSOT §4.1: `arcade_machines` 4행, 영업시간 1/939, 전화 0, 제보·리뷰·즐겨찾기 0). 기종 필터를 고르면 사이드바가 **아무 말 없이 빈 자리**(`ArcadeFinder.tsx:1200-1204` 의도적 `emptyMessage=null`). 챗봇 추천도 기종 기반이라 결과 0. 처음 온 사람에게는 "필터가 고장났다" 로 읽힙니다. 수정: 출시 전 주요 오락실 수십 곳 기종 입력(관리자 화면) **또는** 결과 0 일 때 "아직 기종 정보가 모이지 않았습니다 — 제보해 주세요" 안내.

**H9. 모바일 뷰포트** — `100vh` 4곳(`globals.css:116,901,2260,3100`), `safe-area-inset` 0건, `dvh` 0건 → iOS Safari 에서 하단 FAB(위치·챗봇)이 홈 인디케이터에 걸림. 터치 타깃 `.btn-sm` ≈26px · `.fav-btn` ≈20px · 사이드바 손잡이 20px(WCAG 최소 24, 권장 44). 수정: `100dvh` + `env(safe-area-inset-bottom)` + `@media (pointer: coarse)` 최소 40px.

**H10. 사이드바 목록이 재조회마다 "불러오는 중…" 으로 통째 교체** — `ArcadeList.tsx:76` 는 기존 `items` 를 무시. GPS 300m 이동·기종 칩·반경 변경마다 플리커 + 페이지네이션 사라졌다 돌아옴. `LiveFeed`·`PostList` 는 `loading && items.length===0` 으로 올바르게 처리하는데 파인더만 다름. 수정: 같은 조건 + `aria-busy`.

**H11. 접근성 P1~P3 미해결** (`docs/PERF-A11Y-REPORT.md` 격차가 그대로) — P1 `<li onClick>` 마우스 전용 목록(`ArcadeList.tsx:86-90`, `PostList.tsx:45-53`; 지도 마커가 접근 불가라 목록이 유일한 대체 경로), P2 `aria-live` 0건, P3 챗봇 dialog `aria-modal`·Escape·포커스 복귀 없음(`ChatBot.tsx:238`). 수정: 행을 `<button>` 으로, `.warn` 에 `role=alert`, dialog 계약.

**~~H12. 세션 회수 수단 없음~~ ✅ 고침 (2026-09-13)** — 7일 무상태 토큰이라 로그아웃이 내 쿠키 삭제뿐이었고, 비밀번호를 바꿔도 다른 기기 세션이 살아 있었습니다. `players.token_epoch`(`migrate-057`)를 토큰에 봉하고 `getSession` 이 요청마다 대조합니다. 올리는 곳은 **비밀번호 변경**(`setPlayerPassword`)·**ADMIN_PASSWORD 변경**(`ensureAdminAccount`)·**본인이 누르는 "다른 기기에서 모두 로그아웃"**(`DELETE /api/account/sessions`) 셋입니다. 누른 사람의 쿠키는 새 번호로 재발급해 이어집니다.

---

## 4. Medium

| # | 항목 | 근거 | 한 줄 수정 |
|---|---|---|---|
| M1 | CSRF 방어가 `SameSite=Lax` 하나 | Origin/`Sec-Fetch-Site` 검사 0건. `request.json()` 은 Content-Type 을 안 봄 | 비-GET 에 `Sec-Fetch-Site ∈ {same-origin,none}` 공용 가드 |
| M2 | 첨부가 글 연결과 무관하게 순번 id 로 공개 | `lib/board.ts:632` `getAttachment(id)` 에 `post_id` 조건 없음, 고아 정리 배치 없음, `immutable` 1년 캐시 | `post_id IS NOT NULL` 또는 업로더 본인만, 24h 고아 삭제 배치 |
| M3 | 로그인 1회당 관리자 scrypt 항상 실행 | `login/route.ts:73` `ensureAdminAccount()` 를 모든 닉네임에 호출 (~37ms CPU · 무인증) | 닉네임이 관리자일 때만 |
| M4 | 누구든 서열표 "특수 패턴" 전역 플래그 토글 | `charts/[id]/special/route.ts:21-24,50` 로그인만 요구 | 관리자 전용 또는 `special_marks` 합의 집계로 표시 |
| M5 | 프로세스 내 캐시가 인스턴스 2개 사이 불일치 | `lib/cache.ts:36` 프로세스별, `post-count` 30초 TTL·무효화도 자기 프로세스만 | 총계 TTL 10초 이하 또는 목록 응답에 포함 |
| M6 | 크론이 필요한 일이 전부 읽기·쓰기 경로에 얹혀 있음 | 만료 제보(`reports.ts:205,314`), `login_failures` 정리, 고아 업로드(없음) | `scripts/housekeeping.mjs` + 타이머 |
| M7 | 구조화 로깅·요청 ID 없음 | `x-request-id` 0건, `handle()` 적용 라우트 7/34 | 프록시에서 ID 부여 → `handle()` 로그, 전 라우트 `handle()` |
| M8 | 서드파티 429 처리 | 네이버 지역검색 429 → `/api/places` **502**, 카운터 없음. 지도 키 운영 도메인 등록 체크리스트 없음 | 429 + `Retry-After` 전달, 배포 체크리스트 |
| M9 | 업로드 저장소 cwd 의존·용량 상한 없음 | `lib/uploads.ts:16` `process.cwd()`, 계정당·전체 상한 없음 | `UPLOAD_DIR` 절대경로 + 계정별 일일 바이트 상한 |
| M10 | FK 컬럼 인덱스 누락 | `machine_reports/arcade_reviews/chart_comments/posts/post_comments/post_images.player_id` 전부 | 탈퇴 CASCADE 대비 인덱스 6개 |
| M11 | `MapPerfPanel` 이 운영에서 `/?perf=1` 로 노출 | `ArcadeFinder.tsx:123-124` — 컬링 OFF 토글이 전국 마커를 다 얹음 | `NODE_ENV !== 'production'` 가드 |
| M12 | FallbackMap·map-error 가 개발자 문구를 사용자에게 노출 | `FallbackMap.tsx:380-384` `.env.local` 언급, `NaverMap.tsx:746` 로더 원문 | 운영 문구로 교체 |
| M13 | 커뮤니티 읽기만 해도 Tiptap 전체 번들 | `RichTextEditor` 정적 import ← `PostForm` ← `CommunityView` | `dynamic(() => import('./PostForm'))` |
| M14 | 필드 단위 오류 없음 · 이중 제출 가드 빠진 곳 | 제보 삭제 버튼 미비활성(`ArcadeDetailPanel.tsx:319-327`), `openChart` 연타 시 응답 역전 | seq 가드 · disabled |
| M15 | 조용한 실패 경로 | 리뷰/평가 삭제 실패 무표시, `use-session.ts:55-57` 네트워크 순단 시 비로그인으로 표시 | 실패 문구 + 재시도 |

---

## 5. Low

L1 계정 열거(타이밍 — 없는 계정은 scrypt 생략) · L2 scrypt 파라미터가 해시 문자열에 없음(N 올릴 여지) · L3 `/api/arcades?q=` 길이 상한 없음 · L4 `APP_URL` 없으면 콜백을 Host 헤더로 유추 · L5 `.env.example` 키 유출 이력(`83fb7d6` 에 Gemini 키·지도 키 ID) — **재발급 여부를 코드로는 확인 불가, 출시 전 확인** · L6 챗봇 오류에 모델명 노출 · L7 관리자 댓글 삭제가 경로의 postId 무시 · L8 닉네임 변경 후 옛 이름 사칭 가능 · L9 색 대비 경계(`.game-tab em` ≈3.4:1) · L10 절대 시각 없음(`timeAgo` 만) · L11 `autoFocus` 가 모바일 키보드 즉시 띄움 · L12 서열표 title 에 "서열표" 중복 가능(`TierBoardView.tsx:189-193`).

---

## 6. 테스트·프로세스 (QA 관점의 구조적 격차)

**T1. 테스트가 실 DB 에 의존해 환경에 따라 실패한다**
- 실패 3건: `session-identity` 의 DELETE 케이스는 `isAdminRequest` → `adminRow` → 실 DB(`lib/auth.ts`), `chat-route` 2건은 `listMachines()` → 실 DB. `.env.local` 이 없는 환경에서는 PGlite 콜드 스타트가 5초를 넘겨 타임아웃. **DATABASE_URL 이 있는 개발 머신에서만 통과합니다** → CI 에 올리면 즉시 빨간불.
- 수정: 두 파일에서 `@/lib/arcades` · `adminRow` 를 `vi.mock`, 또는 테스트용 PGlite 픽스처.

**T2. UI 테스트 0 · e2e 0** — `vitest.config.ts` `environment: 'node'`, jsdom·playwright·testing-library 의존성 없음. 컴포넌트 35개 전부 무테스트. B8 의 크래시(`data.games` undefined)가 정확히 이 공백에서 나옵니다.
- 수정: Playwright 스모크 5개(지도 로드 · 제보 등록 · 로그인/로그아웃 · 글 작성 · 서열표 투표)를 `next start` 위에서.

**T3. 통합 테스트 0** — `lib/board.ts` · `tier.ts` · `arcades.ts` · `reports.ts` · `auth.ts(login_failures)` 의 SQL 경로는 모두 미검증. `TESTING.md` 가 08-18 부터 "다음에 덮을 것" 으로 적어 둔 그대로. 임계값 자동 반영(`reports.ts:261-292`)은 지도 데이터를 바꾸는 로직인데 테스트가 없습니다.

**T4. 문서 드리프트** — `TESTING.md` "52개/4파일" (실제 615/28), `README.md` "1,449곳"·"로그인 없음"·"서식 없음", `GUIDELINES.md` §3 마이그레이션 서술(B1). SSOT §10 목록에 B1 항목을 추가해야 합니다.

**P1. 미커밋 작업이 워크트리에 방치돼 있다 (R10 확장)**
- `mfa-jwt-token-status-45e91a`: **이메일 인증 기능 일체** — `lib/mailer.ts` · `lib/email-verify.ts` · `app/api/auth/verify/` · `app/verify-email/` · `migrate-050/051` + 수정 43파일. B5(가입 근거)·B7(계정 복구)의 답이 여기 있는데 커밋되지 않았습니다. 워크트리를 지우면 사라집니다.
- `brighten-background-color-3af3e8`: 다크모드 토글 + `migrate-038/039`(개발 DB 에만 적용된 잔재).
- `community-post-loading-optimization-ab3018`: `HistoryBar.tsx` 신규.
- 수정: 살릴지 버릴지 결정하고 커밋 또는 폐기. 최소한 mfa 워크트리는 패치로 떠 두기.

**P2. 스테이징 환경 없음** — 개발 DB 하나를 모든 워크트리가 공유(`db:reset` 사고 이력). 운영 URL 이 개발 머신 `.env.local` 에 들어가는 순간 같은 사고가 운영에서 재현될 수 있습니다. `init-db.mjs` 에 운영 URL 보호(`--force`) 없음.

---

## 7. 이미 잘 돼 있는 것 (다시 파지 말 것)

- **인가**: 모든 쓰기 라우트가 세션 기준(`requirePlayer`/`requireAdmin`/`sessionPlayerId`), 스키마에 `playerId` 없음, 소유권은 SQL 에서 강제, 관리자는 요청마다 DB 재확인. IDOR 미발견.
- **XSS**: 본문이 JSON 트리 + 화이트리스트, `dangerouslySetInnerHTML` 0곳, `safeHref` `https?://` 만, YouTube id 정규식 + `nocookie` 고정.
- **SQL**: 전부 파라미터 바인딩. 보간 4곳은 상수/화이트리스트.
- **업로드 판별**: 매직바이트 + MIME 허용목록 + 종류별 상한 + SHA-256 파일명 + traversal 차단 + `public/` 미노출.
- **세션 쿠키**: HttpOnly · Lax · Secure(운영) · HMAC-SHA256 · `timingSafeEqual`.
- **시도 제한**: DB(`login_failures`) 저장으로 클러스터에서 합산, 계정 키 정규화, 신뢰 프록시만.
- **OAuth**: state 서명 쿠키 + nonce + PKCE(Google·Kakao), 이메일로 계정 병합 안 함.
- **성능**: 목표의 20배에서 실패 0%, 응답 압축, 만료 정리 부분 인덱스, 뷰포트 컬링·마커 풀링.
- **DB 폴백 판정**: 연결 유실만 폴백, 제약·문법 오류는 절대 사본 재시도 안 함. `/api/health` 가 `db_primary` 로 폴백을 드러냄.
- **프런트 기본기**: 이중 제출 가드 60여 곳, 낙관적 즐겨찾기 + 서버 수렴, 오래된 응답 덮어쓰기 방지(`reqSeq`), 미디어 지연 로딩, 위치 권한 거부 문구, `prefers-reduced-motion`, 하이드레이션 위험 0.

---

## 8. 권장 순서 (QA 관점)

1. **운영 경로부터** — B1 마이그레이션 도구 · B2 폴백 off · B3 프로세스 관리자+백업+CI. 이게 없으면 나머지를 고쳐도 배포할 수 없습니다.
2. **H3 기동 시 env 검증** — R11 · AUTH_SECRET · APP_URL · DB_FALLBACK 을 한 번에 닫습니다.
3. **B4 · B5 · B6 · H1 · H2** — 비용·조작·리다이렉트·헤더. 각각 반나절 이하.
4. **B7 법적 페이지 + 탈퇴** — OAuth 심사 선행 조건이라 가장 먼저 착수해도 됩니다(병행 가능).
5. **B8 · B9 · H8** — 에러 화면 · 지도 인증 실패 · 빈 기종 안내. 첫 인상.
6. **T1 · T2** — 테스트 격리 + Playwright 스모크 5개. 이후 회귀를 CI 가 잡게.
7. **P1** — 미커밋 작업 결정. 이메일 인증을 살리면 B5 · B7 의 절반이 해결됩니다.
8. 나머지 High → Medium.

**출시 게이트 제안**: ① Blocker 9개 닫힘 ② `typecheck && test && build` 가 CI 에서 초록 ③ 스테이징에서 스모크 5개 통과 ④ 복구 리허설 1회(덤프에서 새 DB 로 복원 → 앱 기동 → 로그인) ⑤ NCP 콘솔 운영 도메인 등록 · OAuth 3사 콜백 등록 확인 ⑥ 유출 이력 키 재발급 확인.
