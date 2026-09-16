import { getDb } from './db';

/**
 * 고정 창 사용량 제한 (`rate_counters`, migrate-054).
 *
 * 로그인 잠금(lib/auth.ts login_failures)은 "실패가 N 회면 M 분 잠금" 이고, 이것은
 * "창 하나(예: 하루·10분) 안에서 N 회까지" 입니다. **성공한 요청을 세는** 자리 —
 * 챗봇 호출(비용), 익명 제보(허위·스팸) 가 대상입니다.
 *
 * ─── 왜 DB 인가 ───
 * 운영 구성이 프로세스 2개라(scripts/start-cluster.mjs) 메모리로 세면 한도가
 * 2배로 샙니다. login_failures 를 DB 로 옮긴 것과 같은 이유입니다. 비용은 요청당
 * UPSERT 1회이고, 이 경로들은 초당 수천 번 오는 곳이 아닙니다.
 *
 * ─── 키를 누가 정하는가 ───
 * 키는 **호출하는 쪽이 신뢰할 수 있는 것**으로 만듭니다. 세션의 playerId, 신뢰
 * 프록시가 덧붙인 IP(lib/auth.ts clientKey), 대상 오락실 id 같은 것. 클라이언트가
 * 마음대로 보내는 값을 키에 넣으면 제한이 없는 것과 같습니다 (docs/SECURITY.md ①).
 *
 * ─── 원자성 ───
 * 한 문장 UPSERT 로 "창이 지났으면 1 로, 아니면 +1" 을 합니다. 읽고-더하고-쓰기로
 * 나누면 같은 순간의 두 요청이 서로의 증가를 덮어씁니다.
 */

export interface RateLimitResult {
  /** 이번 요청을 받아도 되는가 */
  allowed: boolean;
  /** 창 안에서 이번 요청까지 센 수 */
  count: number;
  /** 한도 */
  limit: number;
  /** 창이 다시 열릴 때까지(ms). allowed 면 0 */
  retryAfterMs: number;
}

/**
 * 세고 판정합니다. **한도를 넘긴 요청도 셉니다** — 넘긴 뒤 계속 두드리면 창이
 * 끝날 때까지 그대로 막혀 있어야 하고, 세지 않으면 넘긴 순간부터 카운트가
 * 멈춰 다음 요청이 통과합니다.
 */
export async function consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const db = await getDb();
  const { rows } = await db.query<{ count: number | string; window_start: string | Date }>(
    `INSERT INTO rate_counters (key, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN rate_counters.window_start + make_interval(secs => $2::double precision) > now()
                         THEN rate_counters.count + 1
                         ELSE 1 END,
            window_start = CASE WHEN rate_counters.window_start + make_interval(secs => $2::double precision) > now()
                                THEN rate_counters.window_start
                                ELSE now() END
     RETURNING count, window_start`,
    [key, windowMs / 1000],
  );
  const row = rows[0];
  const count = Number(row?.count ?? 1);
  const startedAt = row ? new Date(row.window_start).getTime() : Date.now();
  const allowed = count <= limit;
  const retryAfterMs = allowed ? 0 : Math.max(0, startedAt + windowMs - Date.now());

  // 낡은 줄은 쓰는 김에 치웁니다 (login_failures 와 같은 방식). 넉넉히 하루 지난 것만.
  if (count === 1) {
    await db.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '1 day'`).catch(() => {});
  }

  return { allowed, count, limit, retryAfterMs };
}

/** 응답 문구에 넣을 "N분 뒤" */
export function retryAfterLabel(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}시간`;
  return `${Math.max(1, minutes)}분`;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * env 에서 정수 한도를 읽습니다. 값이 없거나 이상하면 기본값. 0 은 "제한 없음" 이
 * 아니라 "전부 거절" 이므로 그대로 둡니다 — 끄고 싶으면 아주 큰 수를 주세요.
 */
export function limitFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}
