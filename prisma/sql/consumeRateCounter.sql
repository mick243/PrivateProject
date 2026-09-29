-- 고정 창 사용량을 **한 문장으로** 세고 판정 재료를 돌려줍니다 (lib/rate-limit.ts consume).
--
-- 왜 TypedSQL 인가: noteLoginFailure 와 같은 이유 — "창이 지났으면 1 로, 아니면 +1" 은
-- 조건부 UPSERT 라 원자성을 지키려면 SQL 한 문장이어야 합니다.
--
-- @param {String} $1:key
-- @param {Float} $2:windowSeconds
INSERT INTO rate_counters (key, window_start, count)
VALUES ($1::text, now(), 1)
ON CONFLICT (key) DO UPDATE
   SET count = CASE WHEN rate_counters.window_start + make_interval(secs => $2::double precision) > now()
                    THEN rate_counters.count + 1
                    ELSE 1 END,
       window_start = CASE WHEN rate_counters.window_start + make_interval(secs => $2::double precision) > now()
                           THEN rate_counters.window_start
                           ELSE now() END
RETURNING count, window_start;
