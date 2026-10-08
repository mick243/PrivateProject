# 오락실 파인더 — 문서 세트

> 2026-08-25 작성. 기획서(`오락실파인더_기획서.html`) · Notion 개인프로젝트 1~5 · 커밋 기록 16건 · 코드베이스 전수 조사를 근거로 정리한 프로젝트 문서입니다.

| 문서 | 내용 |
|---|---|
| [DESIGN.md](DESIGN.md) | 설계 문서 — 왜 만들었나, 아키텍처, 데이터 모델 원칙, 계정/OAuth 설계, 챗봇·RAG, 실데이터 파이프라인, ADR, 열린 문제 |
| [COMPONENTS.md](COMPONENTS.md) | 컴포넌트 문서 — 28개 컴포넌트 + 클라이언트 훅 7개의 역할·props·상태·접근성 |
| [API-SPEC.md](API-SPEC.md) | API 명세 — 라우트 28개 / 핸들러 40개의 요청·응답·상태 코드·권한 규칙 |
| [PERF-A11Y-REPORT.md](PERF-A11Y-REPORT.md) | 성능·접근성 리포트 — 지도 최적화 실측(−75% CPU · −40% 힙), 접근성 감사(강점/격차 P1~P7) |
| [LOAD-TEST-REPORT.md](LOAD-TEST-REPORT.md) | 부하·성능 리포트 — k6 시나리오, 병목 진단, 개선 전후(p95 287→78ms, 천장 244→380 req/s) |
| [SECURITY.md](SECURITY.md) | 보안 결정과 근거 — 로그인 시도 제한 우회 차단, API 권한을 세션으로. **무엇을 일부러 안 했는지**와 손댈 필요 없는 것 |
| [DB-WORKLOAD.md](DB-WORKLOAD.md) | 데이터 성향별 구분(참조·위치·사용자 생성·휘발·파생·계정)과 전략 · **ORM 전환 전후를 목표 규모 DB 에서 비교(2026-09-28)** · 한글 2글자 검색 한계 · 응답 성향 분리 제안 · 재 보고 안 하기로 한 것 |
| [PRISMA-MIGRATION.md](PRISMA-MIGRATION.md) | Prisma 이관 — SQL 89개를 Prisma 마이그레이션으로, 기존 DB 베이스라인, **데이터 계층 121개 쿼리를 Prisma Client·TypedSQL 로 전환(2026-09-22)**, 값·에러 모양 차이(실측), 개발 DB 의 FK 12개 복구 |
| [DATA-SOURCES.md](DATA-SOURCES.md) | 데이터 원천 — 표마다 어디서 왔나(빈 DB vs 개발 DB 실측) · 스키마/외부 원천/사용자/시연 데이터의 경계 · 원천 대장 · **데이터 릴리스로 새 운영 DB 채우기(2026-09-28)** · 원시 SQL 이 남은 곳 |
| [AI-BUDGET.md](AI-BUDGET.md) | AI 호출의 분량 상한 — 챗봇 대화·도구 결과·쪽 나누기, 리뷰 요약의 리뷰·그림 상한, **전후 실측(최악 −81% · 요약 27.8MB → 1.42MB)** · 늘어난 것 |

관련 원본 문서: [../GUIDELINES.md](../GUIDELINES.md)(**작업 지침** — 성능·보안·API 규칙과 그 근거) · [../PERFORMANCE.md](../PERFORMANCE.md)(조회 성능 개선 기록) · [../TESTING.md](../TESTING.md) · `../../오락실파인더_ERD_관계정리.md` · `../../RAG_적용_정리.md`
