# 데이터 원천 — 어디서 왔고, 새 환경으로 어떻게 옮기나

> 2026-09-28 작성. 수치는 전부 직접 셌습니다 — 개발 DB 사본(`arcade_finder_r2_dev`)과, 빈 DB 에
> 마이그레이션 89개만 적용한 DB(`arcade_finder_r2_fresh`)를 표마다 비교했습니다. 개발 DB 원본은
> 읽기만 했습니다.

## 0. 30초 요약

- **데이터마다 들어오는 길이 하나씩** 있습니다. 스키마와 기준 데이터는 마이그레이션, 외부 원천에서
  가져온 데이터는 **데이터 릴리스**(`npm run data:release`, 2026-09-28 신규), 사용자 데이터는 옮기지
  않고 백업(`pg_dump`)만 합니다.
- 지금까지는 둘째 길이 없었습니다. 빈 DB 에 마이그레이션만 적용하면 **실제 오락실은 0곳**(시드의 가상
  8곳뿐)이고, maimai·CHUNITHM 곡 3,159개 · 채보 13,193개가 없습니다. 운영 DB 를 채우는 방법은 개발 DB
  를 통째로 `pg_dump` → `pg_restore` 하는 것뿐이었고(옛 deploy/README.md), 그러면 개발하며 만든 계정·
  글·투표까지 운영으로 넘어갔습니다.
- 반대로 마이그레이션은 **시연 데이터**를 운영 DB 에 넣습니다 — 가상 계정 12 · 투표 77 · 글 30 · 리뷰 12
  · 제보 26. 이미 적용된 파일이라 고칠 수 없어, 새 DB 는 `db:purge-demo` 로 치우고 새 마이그레이션은
  테스트로 막습니다(§2).
- 새 운영 DB 를 채우는 순서(§4)를 빈 DB 에서 끝까지 돌려 봤습니다. 오락실·곡·채보·모드가 개발 DB 와
  같은 수로 들어가고, 사용자 데이터는 하나도 넘어가지 않았습니다.

## 1. 새 DB 와 개발 DB — 표마다 (실측)

| 표 | 마이그레이션만 | 개발 DB | 차이가 나는 이유 |
|---|---:|---:|---|
| arcades | 8 | 926 | 마이그레이션 쪽 8곳은 전부 가상(`source='seed'`). 실제 오락실은 스크립트가 넣었습니다(§3) |
| arcade_machines · arcade_cabinets | 31 · 45 | 4 · 8 | 마이그레이션 쪽은 가상 오락실의 기종·기체 |
| arcade_machine_guesses | 0 | 11 | AI 기종 추정 (호출마다 비용) |
| songs | 1,812 | 4,971 | +3,159 = maimai DX 1,481 + CHUNITHM 1,678 (`charts:import`) |
| charts | 15,985 | 29,178 | +13,193 = 6,370 + 6,823 |
| machine_modes | 19 | 34 | +15 — 수입기가 곡과 함께 넣는 모드 |
| players | 12 | 16 | 마이그레이션 쪽 12명은 시드의 **가상 투표자**(로그인 수단 없음) |
| difficulty_votes · clear_records | 77 · 198 | 90 · 280 | 시드·마이그레이션이 넣은 가상 투표·클리어 (§2 "경계를 넘은 데이터") |
| posts · post_comments · post_likes | 30 · 29 · 51 | 34 · 29 · 46 | 시드 글 |
| arcade_reviews · machine_reports · chart_comments | 12 · 26 · 5 | 1 · 0 · 17 | 시드의 가상 리뷰·제보·평가 |
| machines · game_versions · machine_difficulties · tier_settings · tier_grades · board_categories · report_settings | 14 · 7 · 4 · 3 · 20 · 6 · 1 | 같음 | 기준 데이터 — 마이그레이션이 넣습니다 |

펌프(곡 833 · 채보 4,466) · 사볼(689 · 691) · EZ2DJ(290 · 10,828)의 곡·채보는 양쪽이 같습니다 —
참고 서열표를 옮긴 마이그레이션이 넣습니다.

같은 내용을 어느 DB 에서든 한 번에 볼 수 있습니다:

```bash
npm run data:release -- report
```

## 2. 경계 — 종류마다 들어오는 길 하나

| 종류 | 표 | 들어오는 길 | 다른 환경으로 옮기는 법 |
|---|---|---|---|
| 스키마 · 기준 데이터 | machines · machine_modes · game_versions · machine_difficulties · tier_settings · tier_grades · board_categories · report_settings · 펌프/사볼/EZ2DJ 의 songs·charts | `db/*.sql` → `prisma/migrations/` (생성) | `npm run db:migrate:prisma` |
| 외부 원천 데이터 | arcades(+ 보유 기종 · 기체) · arcade_machine_guesses · 수입기 기종의 songs·charts·machine_modes | scripts/ 의 수입·대조 도구 (§3) | **`npm run data:release`** (§4) |
| 사용자 데이터 | players · player_identities · posts · post_comments · post_likes · post_images · arcade_reviews · arcade_favorites · machine_reports · difficulty_votes · clear_records · chart_comments · special_marks · email_verifications | 앱 | 옮기지 않습니다 — `pg_dump` 백업만 (deploy/backup.sh) |
| 운영 중에 생기는 값 | rate_counters · login_failures · imported_news · arcade_review_summaries | 앱 · sync-news | 옮기지 않습니다 — 다시 생깁니다 |
| 시연 데이터 | 가상 오락실(`source='seed'`) · 시드 글 · 가상 리뷰·제보 | `db/seed*.sql` (Prisma 마이그레이션 앞쪽 9개 중 시드 4개) | 새 DB 에서 `npm run db:purge-demo -- --apply` 로 치웁니다 |

### 경계를 넘은 데이터 — 알고 있어야 할 빚

1. **시연 데이터가 스키마 마이그레이션 안에 있습니다** (`20260101000100_seed` 등). 이미 적용된 파일은
   고칠 수 없어(Prisma 체크섬 · 옛 러너의 이력) 그대로 두고, 새 DB 는 `db:purge-demo` 로 치웁니다.
   purge-demo 는 가상 오락실 8곳과 시드 글 30개를 지우고(딸린 리뷰·제보·댓글은 CASCADE), **투표가 있는
   가상 계정은 남깁니다** — 아래 2 때문입니다.
2. **서열표 배치 일부가 가상 플레이어의 투표로 저장돼 있습니다.** 서열표는 등급을 따로 저장하지 않고
   투표 평균으로 계산하므로(schema-tier.sql recalc_chart_stats), 원하는 등급을 만들려면 그 등급이 나오는
   투표를 넣는 수밖에 없었습니다. 빈 DB 의 투표 77표는 셋입니다.
   - 사볼 MXM 18 채보 10개 · 67표 — `seed-community.sql` 이 만든 **가상 배치**입니다(그 파일이 "실제
     난이도표가 아닙니다" 라고 적고 있습니다). 운영 DB 에도 그대로 들어가 서열표에 가짜 등급이 보입니다.
   - 사볼 Verse IV [EXH] 17 → A · 3표 (migrate-049), 펌프 S1 Bad Apple!! feat. nomico · 7표 (migrate-012 가
     넣은 S1 배치 중 남은 것) — 참고 서열표를 옮긴 **실제 배치**입니다. 지우면 안 됩니다.
   정리하려면 가상 배치만 고르는 새 마이그레이션(081)이 필요하고, 적용하면 개발 DB 에서도 지워집니다 —
   사용자 결정으로 남깁니다(§6).
3. **앞으로의 규칙: 마이그레이션은 사용자 데이터 표에 행을 만들지 않습니다.** 사용자 데이터 표 목록은
   `lib/data-release.ts` 의 `USER_DATA_TABLES`, 검사는 `tests/data-release.test.ts` 입니다. 옛 여섯 파일
   (seed-tier · seed-community · seed-board · migrate-012 · 020 · 049)은 예외 목록에 묶여 있고, 예외가
   더는 필요 없어지면 그것도 테스트가 알려 줍니다. `UPDATE` · `DELETE` 는 허용합니다 — 투표 척도를 바꾸는
   것처럼 이미 있는 사용자 데이터를 고치는 일은 마이그레이션이 할 일입니다.

## 3. 원천 대장

| 원천 | 들어가는 곳 | 도구 | 열쇠 · 주의 |
|---|---|---|---|
| 네이버 지역 검색 (NAVER API HUB · NCP) | arcades `source='naver'` 526곳 | `npm run arcades:import` (하루 20,000회 상한 · 이어서 하기) | `source_ref` = 이름+주소로 만든 지도 검색 링크. 영업시간·기종은 응답에 없습니다. **검색 결과라 공개 저장소에 커밋하지 않습니다** |
| 공공데이터포털 청소년게임제공업 (15154958) | arcades `source='localdata'` 398곳 | `npm run games:localdata` → `arcades:localdata -- --geocode --write` | `source_ref` = `localdata:youth:{지자체}:{관리번호}`. 이름·주소만 (좌표는 주소를 옮긴 것) |
| 네이버 대조 · 중복 병합 | arcades 삭제·이름 통일 | `arcades:verify` · `arcades:dedupe` | 지우기 전에 행 전체를 `localdata/*.json` 에 남깁니다 |
| 사람이 등록 | arcades `source='manual'` 2곳 | 관리자 화면 | `source_ref` 가 없어 열쇠는 출처+이름+주소 |
| SEGA 공식 곡 목록 (maimai DX · CHUNITHM JSON) | 두 기종의 songs · charts · machine_modes | `npm run charts:import -- maimai --write` (출처 목록은 lib/chart-sources.ts `SOURCES`) | 출처에서 사라진 곡은 지우지 않고 세기만 합니다 |
| 참고 서열표 · 위키 (mentormin · 나무위키 · SDVX 17 스프레드시트 …) | 펌프 · 사볼 · EZ2DJ 의 곡 · 채보 | 마이그레이션 (migrate-005 … 079) | 원 표기와 출처는 각 파일 머리말 |
| Gemini | arcade_machine_guesses · arcade_review_summaries | 상세 화면 단추 · `guess-arcade-machines.mjs` · 요약 API | 추정은 릴리스에 **담습니다**(다시 만들면 비용). 요약은 담지 않습니다(리뷰가 없는 곳에서는 뜻이 없음) |
| 게임 공식 소식 | imported_news | `sync-news.mjs` (매일) | 릴리스에 담지 않습니다 — 새 환경에서 다시 가져옵니다 |

2026-09-28 부터 위 도구 중 `.ts` 여섯 개(수입 셋 · 좌표 갱신 둘 · 네이버 대조)는 옛 어댑터(`lib/db.ts`,
원시 SQL · PGlite 폴백) 대신 **Prisma**(`lib/prisma.ts`)로 씁니다. `DATABASE_URL` 이 없으면 시작할 때
멈춥니다 — 예전에는 조용히 `.pglite` 로 내려가 "끝났다" 고 말한 뒤 실 DB 에는 아무것도 남기지 않을 수
있었습니다. 검증은 docs/PRISMA-MIGRATION.md §11.

## 4. 데이터 릴리스 — 새 환경 채우기

```bash
npm run data:release -- report                  # 이 DB 의 데이터가 어디서 왔는지 (읽기만)
npm run data:release -- export                  # backups/data-release/<시각>/ 에 릴리스 (읽기만)
npm run data:release -- verify <폴더>            # 이 DB 가 릴리스를 다 갖고 있는가 (읽기만 · 다르면 종료 코드 1)
npm run data:release -- import <폴더>            # 미리보기
npm run data:release -- import <폴더> --write    # 넣기 — 없는 것만 더합니다 (--update: 원천 칸도 고침)
```

**형식** — `manifest.json`(형식 번호 · 원본 DB 이름 · 파일별 행 수와 sha256 · 출처별 요약 · 담지 않은 표와
이유) + `arcades.jsonl`(보유 기종·기체·AI 추정 포함) + `catalog-songs.jsonl`(채보 포함) +
`catalog-modes.jsonl`. 규칙은 `lib/data-release.ts` 머리말에 있습니다.

- **id 가 아니라 자연 키로 옮깁니다** — 오락실은 `source_ref`, 곡은 (기종 이름, 제목), 채보는 (버전 코드,
  모드, 난이도, 층 이름). 같은 곡이라도 DB 마다 id 가 다릅니다. 개발 DB 는 maimai 를 EZ2DJ 마이그레이션보다
  먼저 넣어서, 마이그레이션이 만든 곡의 id 부터 새 DB 와 어긋납니다.
- **결정적입니다** — 같은 DB 를 두 번 내보내면 세 파일이 바이트 단위로 같습니다(코드포인트 순 정렬 · 시각
  칸 제외). 적재 전에 sha256 을 대조해, 덜 복사됐거나 손댄 릴리스는 넣지 않습니다.
- **더하기만 합니다** — 대상에 없는 것만 넣고 지우지 않습니다. 운영에서는 사용자 제보가 보유 기종·기체를
  바꾸므로, 이미 있는 오락실의 기종·기체는 `--update` 여도 건드리지 않습니다.
- **트랜잭션 하나**입니다 — 중간에 실패하면 아무것도 남지 않습니다. 대상 DB 에 적용되지 않은 마이그레이션이
  하나라도 있으면 시작하지 않습니다.

**새 운영 DB 를 채우는 순서**

```bash
npm run db:migrate:prisma                        # 스키마 + 기준 데이터
npm run db:purge-demo -- --apply                 # 시드가 넣은 가상 오락실·글 치우기
npm run data:release -- import <폴더> --write     # 외부 원천 데이터
npm run data:release -- verify <폴더>             # 확인
```

**실측 (2026-09-28, 개발 DB 사본 → 빈 DB)**

| 단계 | 결과 |
|---|---|
| export 두 번 | 세 파일의 sha256 이 같음 · arcades.jsonl 582KB · catalog-songs.jsonl 1.56MB · catalog-modes.jsonl 1KB |
| 담긴 것 | 오락실 926 (네이버 526 · 공공데이터 398 · 수동 2) · 보유 기종 4 · 기체 8 · AI 추정 11 · CHUNITHM 곡 1,678 · 채보 6,823 · 모드 5 · maimai DX 곡 1,481 · 채보 6,370 · 모드 10 |
| purge-demo | 가상 오락실 8 · 시드 글 30 삭제 |
| import --write | 1.8초 · 오락실 926 · 곡 3,159 · 채보 13,193 · 모드 15 |
| verify | 없음 0 · 다름 0 (종료 코드 0) |
| import --write 한 번 더 | 넣은 것 0 — 여러 번 돌려도 같습니다 |
| 결과 행 수 | arcades 926 · songs 4,971 · charts 29,178 · machine_modes 34 · arcade_machines 4 · arcade_cabinets 8 · guesses 11 — **개발 DB 와 같음**. posts 0 · arcade_reviews 0 · post_comments 0 |
| 실 DB 스모크 (`PRISMA_SMOKE_URL`) | 4/4 통과 |
| 남은 시연 데이터 | 가상 투표자 12 · 투표 77 · 클리어 198 · 채보 평가 5 — §2 "경계를 넘은 데이터" 2 |

⚠ **릴리스 폴더는 커밋하지 않습니다.** 기본 위치 `backups/` 는 .gitignore 에 있습니다. 네이버 지역 검색
결과가 들어 있고, GitHub 저장소는 공개입니다. 운영 서버로는 scp 같은 방법으로 직접 옮기세요.

## 5. 원시 SQL 이 남은 곳

| 어디 | 호출 수 | 왜 남았나 |
|---|---:|---|
| 앱 (`lib/**` · `app/**`) | 0 | TypedSQL 10개만 — 파라미터가 타입과 함께 묶입니다 (tests/architecture.test.ts) |
| `scripts/*.ts` | 0 | 2026-09-28 에 Prisma 로 옮김. pg 를 직접 import 하면 architecture.test.ts 가 실패합니다 |
| 스키마 러너 — `migrate.mjs` · `init-db.mjs` · `prisma-baseline.mjs` · `apply-views.mjs`, lib/prisma.ts 의 뷰 적용 · `_prisma_migrations` 조회 | — | 스키마 자체와 이력 표를 다루는 도구입니다. SQL 파일을 실행하는 것이 일입니다 |
| `.mjs` 관리 도구 — `dedupe-arcades` 13 · `sync-news` 15 · `prune-passwordless-players` 8 · `purge-demo-data` 5 · `guess-arcade-machines` 4 | 45 | 타입 검사를 받지 않는 `.mjs` 라 옮겨도 얻는 것이 작고, 병합(dedupe)은 여러 표의 행을 옮기는 SQL 이라 따로 검증이 필요합니다. 다음 후보입니다 |
| PGlite 도구 — `snapshot-pg-to-pglite.mjs` · `migrate-pglite-to-pg.mjs` · `init-db.mjs --pglite` | — | 앱의 PGlite 폴백이 09-22 에 사라져 **이 사본을 읽는 곳이 없습니다.** 삭제 후보입니다 (`@electric-sql/pglite` 의존성과 함께) |

## 6. 하지 않은 것 · 다음

- **시드 파일에서 시연 데이터를 떼어 내지 않았습니다.** 이미 적용된 마이그레이션이고(체크섬 · 옛 러너 이력),
  migrate-049 가 시드의 가상 플레이어와 클리어 기록에 기대 실제 배치를 만들기 때문에, 떼어 내면 실제 서열표
  배치까지 사라집니다.
- **릴리스를 git 에 넣지 않았습니다.** 네이버 검색 결과 · 공개 저장소 (§4).
- 제안 — 사볼 MXM 18 가상 배치(채보 10 · 67표) 정리 마이그레이션 · 가상 투표자를 시스템 계정으로 표시하는
  칸(`players.kind`) · PGlite 도구 삭제 · `.mjs` 관리 도구의 Prisma 이관 · 개발 DB 베이스라인
  (`npm run db:prisma:baseline`, 여러 워크트리가 공유하는 DB 라 사람이 돌립니다).
