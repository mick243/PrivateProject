-- 비밀번호를 대조하기 **전에** 시도 한 번을 세고, 센 결과를 돌려줍니다 (lib/auth.ts takeLoginAttempt).
--
-- 왜 먼저 세는가: "잠겼나 읽기 → 대조(scrypt 수십 ms) → 틀리면 기록" 순서에서는 동시에 들어온
-- 요청이 모두 읽기 단계를 통과한 뒤에야 기록됩니다. 50개를 한꺼번에 보내면 8회 제한이 50회가
-- 됩니다. 판정의 근거를 이 한 문장의 RETURNING 으로 받으면 동시 요청도 하나씩 줄을 섭니다.
--
-- 잠긴 동안 들어온 시도는 until 을 늘리지 않습니다 — 늘리면 남이 계속 두드리는 것만으로
-- 표적 계정을 영영 잠가 둘 수 있습니다. count 도 한도+1 에서 멈춥니다.
--
-- @param {String} $1:key
-- @param {Int} $2:lockMinutes
-- @param {Int} $3:maxAttempts
INSERT INTO login_failures (key, count, until)
VALUES ($1::text, 1, now() + make_interval(mins => $2::int))
ON CONFLICT (key) DO UPDATE
   SET count = CASE WHEN login_failures.until > now()
                    THEN LEAST(login_failures.count + 1, $3::int + 1)
                    ELSE 1 END,
       until = CASE WHEN login_failures.until > now() AND login_failures.count > $3::int
                    THEN login_failures.until
                    ELSE now() + make_interval(mins => $2::int) END,
       updated_at = now()
RETURNING count, until;
