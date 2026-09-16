import type { Db, Queryable } from './db';

/**
 * 요청·쿼리 계측 → 30초 집계 → Pulse 로 push.
 *
 * `/api/health` 가 "지금 살아 있는가" 라면, 이쪽은 "실제 사용자가 무엇을 겪고 있는가" 다:
 * 라우트별 요청수·p95·5xx, SQL 지문별 호출수·p95·에러·느린 쿼리. 값은 프로세스 메모리에서
 * 모아 30초마다 한 번 보내므로 요청 경로에 얹히는 비용은 Map 갱신 하나뿐이다.
 *
 * PULSE_AGENT_KEY / PULSE_API_URL 이 없으면 전부 no-op 이다 — 계측을 켜지 않은 환경에서는
 * 비용도, Pulse 가 죽었을 때의 영향도 0. 전송 실패는 경고만 남기고 그 창의 집계를 버린다
 * (에이전트처럼 버퍼링하지 않는다 — 30초짜리 평균 하나가 빠지는 것은 감시에 문제가 아니고,
 * 앱 메모리에 지표를 쌓아 두는 쪽이 더 나쁘다).
 *
 * 지표 이름 규약 (Pulse 는 라벨이 없어 이름에 담는다 — 64자 제한, 마지막 점 뒤가 통계 이름)
 *   app.http.rpm | app.http.p95_ms | app.http.4xx | app.http.5xx      전체 요청
 *   app.db.qpm   | app.db.p95_ms   | app.db.errors | app.db.slow      전체 쿼리
 *   app.db.wait_p95_ms | app.db.exec_p95_ms | app.db.exec_slow        풀 대기 / 순수 실행
 *   app.loop.p95_ms | app.loop.max_ms                                 이벤트 루프 지연
 *   route.<METHOD /api/경로/[id]>.rpm|p95_ms|5xx                      /api/* 라우트별
 *   query.<VERB 테이블>.qpm|p95_ms|errors|slow|exec_ms                 SQL 지문별
 *
 * ⚠ p95_ms 는 **DB 를 부른 코드가 체감한 시간** 이다 — 풀 슬롯을 기다린 시간과, 노드
 *   이벤트 루프가 밀려서 await 가 늦게 깨어난 시간이 함께 들어간다. 그래서 프로세스가
 *   포화되면 `SELECT 1` 도 수백 ms 로 기록된다 (2026-09-08 에 실제로 그렇게 읽혔다).
 *   무엇이 느린지 가르려면 셋을 나란히 본다:
 *     app.db.exec_p95_ms  ← 순수 SQL 실행. 이게 높으면 정말 DB·쿼리 문제다.
 *     app.db.wait_p95_ms  ← 풀 슬롯 대기. 이게 높으면 PG_POOL_MAX 나 요청당 쿼리 수.
 *     app.loop.p95_ms     ← 이벤트 루프 지연. 이게 높으면 노드 CPU 포화다(쿼리 무죄).
 *
 * ⚠ 서버리스(Vercel)에서는 인스턴스가 요청마다 사라져 집계가 쌓이지 않는다. 그런 환경은
 *   요청 끝에 waitUntil 로 보내거나 플랫폼 관측 도구를 쓴다. 이 모듈은 상주 프로세스용이다.
 */

export const FLUSH_MS = 30_000;
/** 이보다 오래 걸린 쿼리는 "느린 쿼리" 로 따로 센다 */
export const SLOW_QUERY_MS = 250;
/** 버킷당 p95 표본 상한 — 넘어가면 저수지 표본(reservoir sampling) */
const MAX_SAMPLES = 500;
/** 라우트/지문 종류 상한 — 넘어가면 '(other)' 로 묶어 카디널리티 폭발을 막는다 */
const MAX_KEYS = 150;
/** Pulse 지표 이름 64자: 'query.'(6) + key + '.errors'(7) 가 들어가야 한다 */
const KEY_MAX_LEN = 48;

type Bucket = {
  count: number;
  /** http: 5xx · db: 실패한 쿼리 */
  errors: number;
  /** http: 4xx */
  warns: number;
  /** db: SLOW_QUERY_MS 이상 */
  slow: number;
  samples: number[];
};

const newBucket = (): Bucket => ({ count: 0, errors: 0, warns: 0, slow: 0, samples: [] });

type State = {
  httpAll: Bucket;
  dbAll: Bucket;
  /** 풀 슬롯을 기다린 시간만 (pool.connect) */
  dbWait: Bucket;
  /** 슬롯을 잡은 뒤 순수 실행 시간만 (client.query) */
  dbExecAll: Bucket;
  /** 지문별 순수 실행 시간 */
  dbExec: Map<string, Bucket>;
  http: Map<string, Bucket>;
  db: Map<string, Bucket>;
  windowStart: number;
};

/**
 * 집계 상태는 globalThis 에 둔다 — 모듈 스코프에 두면 안 되는 이유가 둘이다.
 *  1. Next 는 instrumentation.ts(스팬 프로세서·리포터)와 앱 코드(lib/db.ts 의 쿼리 래퍼)를
 *     **다른 번들**로 만들어서 이 모듈이 두 번 평가된다. 그러면 쿼리는 A 에 쌓이고 flush 는 B 를
 *     읽어 DB 지표가 영원히 0 이다. (실제로 겪었다.)
 *  2. dev HMR 로 모듈이 다시 평가되면 창 중간의 집계가 날아간다.
 * `__db` 를 globalThis 에 두는 lib/db.ts 와 같은 이유다.
 */
const globalForTelemetry = globalThis as unknown as {
  __pulseTelemetry?: State;
  /** node:perf_hooks 의 IntervalHistogram. lib/telemetry-node.ts 가 채운다. */
  __pulseLoopLag?: { percentile(p: number): number; max: number; reset(): void };
};

function getState(): State {
  return (globalForTelemetry.__pulseTelemetry ??= {
    httpAll: newBucket(),
    dbAll: newBucket(),
    dbWait: newBucket(),
    dbExecAll: newBucket(),
    dbExec: new Map(),
    http: new Map(),
    db: new Map(),
    windowStart: Date.now(),
  });
}

export function enabled(): boolean {
  return Boolean(process.env.PULSE_AGENT_KEY && process.env.PULSE_API_URL);
}

function bucketFor(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (b) return b;
  if (map.size >= MAX_KEYS) key = '(other)';
  b = map.get(key);
  if (!b) {
    b = newBucket();
    map.set(key, b);
  }
  return b;
}

function add(b: Bucket, ms: number, opts: { error?: boolean; warn?: boolean; slow?: boolean }): void {
  b.count++;
  if (opts.error) b.errors++;
  if (opts.warn) b.warns++;
  if (opts.slow) b.slow++;
  if (b.samples.length < MAX_SAMPLES) b.samples.push(ms);
  else {
    const j = Math.floor(Math.random() * b.count);
    if (j < MAX_SAMPLES) b.samples[j] = ms;
  }
}

/** 요청 하나. route 는 'GET /api/arcades/[id]/reviews' 꼴 — 라우트별 버킷은 /api/* 만 만든다. */
export function recordHttp(route: string, status: number, ms: number): void {
  if (!enabled()) return;
  const state = getState();
  const flags = { error: status >= 500, warn: status >= 400 && status < 500 };
  add(state.httpAll, ms, flags);
  const path = route.split(' ')[1] ?? route;
  if (path.startsWith('/api/')) add(bucketFor(state.http, trimKey(normalizeRoute(route))), ms, flags);
}

/** 쿼리 하나. SQL 은 지문으로 줄여서 담는다 — 원문은 절대 밖으로 나가지 않는다. */
export function recordQuery(sql: string, ms: number, ok: boolean): void {
  if (!enabled()) return;
  const state = getState();
  const flags = { error: !ok, slow: ms >= SLOW_QUERY_MS };
  add(state.dbAll, ms, flags);
  add(bucketFor(state.db, trimKey(fingerprint(sql))), ms, flags);
}

/**
 * 커넥션 풀이 쪼갠 시간. lib/db.ts 의 pg 어댑터가 부른다.
 *
 * recordQuery 가 재는 전체 시간에서 이 둘을 떼어 내면 남는 것이 이벤트 루프 지연이다.
 * 풀 대기는 지문별로 나누지 않는다 — 대기는 그 쿼리의 성질이 아니라 그 순간 풀의
 * 혼잡도라서, 지문에 붙이면 "우연히 붐빌 때 실행된 쿼리" 가 느린 쿼리로 지목된다.
 */
export function recordPoolQuery(sql: string, waitMs: number, execMs: number): void {
  if (!enabled()) return;
  const state = getState();
  add(state.dbWait, waitMs, {});
  add(state.dbExecAll, execMs, { slow: execMs >= SLOW_QUERY_MS });
  add(bucketFor(state.dbExec, trimKey(fingerprint(sql))), execMs, {});
}

/**
 * SQL → 'SELECT arcades' 같은 지문. 동사 + 주 테이블만 남긴다.
 * 스키마 접두어(public.x)는 뗀다 — 지표 이름에서 점은 통계 구분자라 들어가면 안 된다.
 */
export function fingerprint(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  const verb = (s.match(/^(select|insert|update|delete|with|begin|commit|rollback|create|drop|alter|set)\b/i)?.[1] ?? s.split(' ')[0] ?? '?')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  // 식별자는 따옴표가 있을 수 있다 (FROM "arcades"). `FROM (서브쿼리` 는 건너뛰고 다음 FROM <이름> 을 찾는다.
  // 식별자 토큰: 따옴표·스키마 접두어 포함 ("public"."reviews"). 뒤에서 따옴표를 떼고 마지막 세그먼트만 쓴다.
  const ident = /([\w."]+)/.source;
  let table: string | undefined;
  switch (verb) {
    case 'INSERT':
      table = s.match(new RegExp(`\\binto\\s+${ident}`, 'i'))?.[1];
      break;
    case 'UPDATE':
      table = s.match(new RegExp(`^update\\s+(?:only\\s+)?${ident}`, 'i'))?.[1];
      break;
    case 'SELECT':
    case 'DELETE':
    case 'WITH':
      table = s.match(new RegExp(`\\bfrom\\s+${ident}`, 'i'))?.[1];
      break;
    case 'CREATE':
    case 'DROP':
    case 'ALTER':
      table = s.match(new RegExp(`\\b(?:table|index|view)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?${ident}`, 'i'))?.[1];
      break;
  }
  const name = table?.replace(/"/g, '').split('.').filter(Boolean).pop();
  return name ? `${verb} ${name}` : verb || '?';
}

/** 매칭 안 된 요청(404 등)은 실제 경로가 오므로 숫자 세그먼트를 [id] 로 접고 쿼리스트링을 뗀다 */
function normalizeRoute(route: string): string {
  return route.replace(/\?.*$/, '').replace(/\/\d+(?=\/|$)/g, '/[id]');
}

function trimKey(key: string): string {
  return key.length > KEY_MAX_LEN ? key.slice(0, KEY_MAX_LEN - 1) + '…' : key;
}

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export type Sample = { ts: string; metric: string; value: number };

/** 지금까지의 창을 지표 목록으로 바꾸고 창을 비운다. */
export function snapshot(now = Date.now()): Sample[] {
  const state = getState();
  const windowSec = Math.max(1, (now - state.windowStart) / 1000);
  const perMin = (count: number) => (count * 60) / windowSec;
  const ts = new Date(now).toISOString();
  const out: Sample[] = [];
  const push = (metric: string, value: number) => out.push({ ts, metric, value: Math.round(value * 100) / 100 });

  push('app.http.rpm', perMin(state.httpAll.count));
  push('app.http.p95_ms', p95(state.httpAll.samples));
  push('app.http.4xx', state.httpAll.warns);
  push('app.http.5xx', state.httpAll.errors);
  push('app.db.qpm', perMin(state.dbAll.count));
  push('app.db.p95_ms', p95(state.dbAll.samples));
  push('app.db.errors', state.dbAll.errors);
  push('app.db.slow', state.dbAll.slow);
  push('app.db.wait_p95_ms', p95(state.dbWait.samples));
  push('app.db.exec_p95_ms', p95(state.dbExecAll.samples));
  push('app.db.exec_slow', state.dbExecAll.slow);

  // 이벤트 루프 지연. 히스토그램은 nodejs 런타임에서만 만들어지므로(lib/telemetry-node.ts)
  // 없으면 건너뛴다 — edge 번들에서 node:perf_hooks 를 import 하지 않기 위한 우회다.
  const lag = globalForTelemetry.__pulseLoopLag;
  if (lag) {
    push('app.loop.p95_ms', lag.percentile(95) / 1e6);
    push('app.loop.max_ms', lag.max / 1e6);
    lag.reset();
  }

  for (const [key, b] of state.http) {
    push(`route.${key}.rpm`, perMin(b.count));
    push(`route.${key}.p95_ms`, p95(b.samples));
    push(`route.${key}.5xx`, b.errors);
  }
  for (const [key, b] of state.db) {
    push(`query.${key}.qpm`, perMin(b.count));
    push(`query.${key}.p95_ms`, p95(b.samples));
    push(`query.${key}.errors`, b.errors);
    push(`query.${key}.slow`, b.slow);
  }
  // 이름이 'exec_p95_ms' 가 아니라 'exec_ms' 인 이유는 64자 예산이다:
  // 'query.'(6) + 키 48 + '.exec_p95_ms'(12) = 66 으로 넘친다. 값은 p95 다.
  for (const [key, b] of state.dbExec) push(`query.${key}.exec_ms`, p95(b.samples));

  state.httpAll = newBucket();
  state.dbAll = newBucket();
  state.dbWait = newBucket();
  state.dbExecAll = newBucket();
  state.dbExec.clear();
  state.http.clear();
  state.db.clear();
  state.windowStart = now;
  return out;
}

/** Db 어댑터를 감싸 모든 query/exec/transaction 을 잰다. 계측이 꺼져 있으면 원본을 그대로 돌려준다. */
export function withTelemetry(db: Db): Db {
  if (!enabled()) return db;

  const timed = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      const result = await run();
      recordQuery(sql, performance.now() - t0, true);
      return result;
    } catch (err) {
      recordQuery(sql, performance.now() - t0, false);
      throw err;
    }
  };
  const wrapQueryable = (q: Queryable): Queryable => ({
    query: (text, params) => timed(text, () => q.query(text, params)),
  });

  return {
    query: (text, params) => timed(text, () => db.query(text, params)),
    exec: (sql) => timed(sql, () => db.exec(sql)),
    transaction: (fn) => db.transaction((tx) => fn(wrapQueryable(tx))),
  };
}

type FetchLike = typeof fetch;

export async function flush(fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (!enabled()) return false;
  const samples = snapshot();
  const url = process.env.PULSE_API_URL!.replace(/\/+$/, '') + '/api/v1/metrics';
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PULSE_AGENT_KEY}` },
      body: JSON.stringify({
        agentId: process.env.PULSE_AGENT_ID ?? 'arcade-finder',
        sentAt: new Date().toISOString(),
        samples,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.warn(`[telemetry] Pulse 가 ${res.status} 를 돌려줌 — 이 창의 지표 ${samples.length}개는 버린다`);
    return res.ok;
  } catch (err) {
    console.warn('[telemetry] Pulse 전송 실패 —', err instanceof Error ? err.message : err);
    return false;
  }
}

const globalForReporter = globalThis as unknown as { __pulseReporter?: ReturnType<typeof setInterval> };

/** 30초마다 flush. dev HMR 로 모듈이 다시 평가돼도 타이머가 겹치지 않게 globalThis 에 둔다. */
export function startReporter(fetchImpl: FetchLike = fetch): boolean {
  if (!enabled() || globalForReporter.__pulseReporter) return false;
  const timer = setInterval(() => void flush(fetchImpl), FLUSH_MS);
  timer.unref?.(); // 이 타이머 때문에 프로세스가 못 내려가면 안 된다
  globalForReporter.__pulseReporter = timer;
  return true;
}

/** 테스트용 — 상태를 초기화한다 */
export function _resetForTests(): void {
  const state = getState();
  state.httpAll = newBucket();
  state.dbAll = newBucket();
  state.dbWait = newBucket();
  state.dbExecAll = newBucket();
  state.dbExec.clear();
  state.http.clear();
  state.db.clear();
  state.windowStart = Date.now();
  if (globalForReporter.__pulseReporter) {
    clearInterval(globalForReporter.__pulseReporter);
    globalForReporter.__pulseReporter = undefined;
  }
}
