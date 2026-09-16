-- ============================================================
-- 054 · 고정 창(fixed-window) 사용량 카운터
--
-- 로그인 잠금(login_failures)은 "실패 N 회면 M 분 잠금" 이라 모양이 다릅니다.
-- 이 표는 "창 하나 안에서 몇 번 했나" 를 셉니다 — 챗봇 일일 한도, 익명 제보
-- 쿨다운처럼 **성공한 요청**을 세는 자리입니다 (lib/rate-limit.ts).
--
-- 저장소가 Postgres 인 이유는 login_failures 와 같습니다: 운영 구성이 프로세스
-- 2개라 메모리로 세면 한도가 2배로 샙니다. 비용은 요청당 UPSERT 1회.
--
-- 키 모양은 lib/rate-limit.ts 가 정합니다 (예: chat:player:42 · report:anon:17).
-- 창이 지난 줄은 다음 UPSERT 가 덮어쓰고, 오래된 줄은 쓰는 김에 치웁니다.
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_counters (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_counters_window_idx ON rate_counters (window_start);
