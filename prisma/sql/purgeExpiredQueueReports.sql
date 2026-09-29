-- 수명이 지난 대기 제보를 지웁니다 (lib/reports.ts purgeExpiredQueueReports).
--
-- 왜 TypedSQL 인가: 기준 시각이 앱이 아니라 **DB 의 now()** 여야 합니다 — 두 곳에서 시간을
-- 재면 서버 시계가 조금만 어긋나도 machine_live 뷰에는 보이는데 이미 지워진 행이 생깁니다.
-- 수명(report_settings.queue_ttl_minutes)도 같은 문장 안에서 읽어 뷰와 같은 값을 씁니다.
DELETE FROM machine_reports r
USING report_settings cfg
WHERE cfg.id = 1
  AND r.kind = 'queue'
  AND r.created_at <= now() - make_interval(mins => cfg.queue_ttl_minutes)
RETURNING r.id;
