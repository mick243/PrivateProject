-- 로그인 실패 한 번을 **한 문장으로** 셉니다 (lib/auth.ts noteLoginFailure).
--
-- 왜 TypedSQL 인가: 읽고-더하고-쓰기로 나누면 같은 순간의 두 시도가 서로의 증가를 덮어씁니다.
-- Prisma Client 의 upsert 는 "잠금이 지났으면 1 로, 아니면 +1" 같은 조건부 갱신을 표현하지
-- 못하므로 원자적 UPSERT 를 SQL 로 둡니다.
--
-- @param {String} $1:key
-- @param {Int} $2:lockMinutes
INSERT INTO login_failures (key, count, until)
VALUES ($1::text, 1, now() + make_interval(mins => $2::int))
ON CONFLICT (key) DO UPDATE
   SET count = CASE WHEN login_failures.until > now()
                    THEN login_failures.count + 1
                    ELSE 1 END,
       until = now() + make_interval(mins => $2::int),
       updated_at = now()
RETURNING count;
