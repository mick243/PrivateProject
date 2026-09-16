import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db';
import type { Sample } from '@/lib/telemetry';

/**
 * 요청·쿼리 계측 — **무엇을 어떤 이름으로 내보내는가**를 고정합니다.
 *
 * Pulse 는 라벨이 없어 지표 이름이 곧 계약입니다. 이름 규칙이 흔들리면 대시보드의 표가
 * 조용히 비고, 64자를 넘으면 수집 API 가 400 으로 창 전체를 거절합니다. 그래서 값보다
 * 이름과 경계(길이·카디널리티·리셋)를 봅니다.
 */

const ENV = { PULSE_API_URL: 'http://pulse.test/', PULSE_AGENT_KEY: 'pk_test' };
Object.assign(process.env, ENV);

const t = await import('@/lib/telemetry');

beforeEach(() => {
  Object.assign(process.env, ENV);
  t._resetForTests();
});
afterAll(() => t._resetForTests());

const byName = (samples: Sample[]) => Object.fromEntries(samples.map((s) => [s.metric, s.value]));

describe('fingerprint — SQL 을 "동사 테이블" 로 줄인다', () => {
  it.each([
    ['SELECT a.id, a.name FROM arcades a WHERE a.id = $1', 'SELECT arcades'],
    ['select count(*) from reviews where arcade_id = $1', 'SELECT reviews'],
    ['INSERT INTO arcade_cabinets (arcade_id, machine_id) VALUES ($1, $2)', 'INSERT arcade_cabinets'],
    ['UPDATE players SET nickname = $1 WHERE id = $2', 'UPDATE players'],
    ['DELETE FROM posts WHERE id = $1', 'DELETE posts'],
    ['WITH base AS (SELECT * FROM posts) SELECT * FROM base', 'WITH posts'],
    ['SELECT 1', 'SELECT'],
    ['\n  SELECT\n    m.id\n  FROM   machines m\n', 'SELECT machines'],
  ])('%s → %s', (sql, expected) => {
    expect(t.fingerprint(sql)).toBe(expected);
  });

  it('스키마 접두어를 뗀다 — 지표 이름에서 점은 통계 구분자다', () => {
    expect(t.fingerprint('SELECT * FROM public.arcades')).toBe('SELECT arcades');
    expect(t.fingerprint('SELECT * FROM public.arcades')).not.toContain('.');
  });

  it('따옴표 식별자와 FROM (서브쿼리) 도 주 테이블을 찾는다', () => {
    expect(t.fingerprint('SELECT * FROM "arcades" WHERE id = $1')).toBe('SELECT arcades');
    expect(t.fingerprint('INSERT INTO "public"."reviews" (a) VALUES ($1)')).toBe('INSERT reviews');
    expect(t.fingerprint('SELECT * FROM (SELECT * FROM posts WHERE x = 1) sub LIMIT 10')).toBe('SELECT posts');
    expect(t.fingerprint('UPDATE ONLY players SET x = 1')).toBe('UPDATE players');
  });
});

describe('snapshot — 창을 지표로 바꾼다', () => {
  it('총량 + /api 라우트별, 페이지는 총량에만', () => {
    const start = Date.now();
    t.snapshot(start); // 창 시작을 고정
    t.recordHttp('GET /api/arcades/[id]/reviews', 200, 100);
    t.recordHttp('GET /api/arcades/[id]/reviews', 200, 200);
    t.recordHttp('GET /api/arcades/[id]/reviews', 500, 300);
    t.recordHttp('GET /', 200, 50); // 페이지 — 라우트 버킷 없음

    const m = byName(t.snapshot(start + 30_000));
    expect(m['app.http.rpm']).toBe(8); // 4건 / 30초 = 분당 8
    expect(m['app.http.5xx']).toBe(1);
    expect(m['app.http.p95_ms']).toBe(300);
    expect(m['route.GET /api/arcades/[id]/reviews.rpm']).toBe(6);
    expect(m['route.GET /api/arcades/[id]/reviews.p95_ms']).toBe(300);
    expect(m['route.GET /api/arcades/[id]/reviews.5xx']).toBe(1);
    expect(Object.keys(m).some((k) => k.startsWith('route.GET /.'))).toBe(false);
  });

  it('쿼리는 지문별로, 느린 쿼리와 에러를 따로 센다', () => {
    const start = Date.now();
    t.snapshot(start);
    t.recordQuery('SELECT * FROM reviews WHERE arcade_id = $1', 20, true);
    t.recordQuery('SELECT * FROM reviews WHERE arcade_id = $2', 400, true); // slow
    t.recordQuery('INSERT INTO reviews (a) VALUES ($1)', 5, false); // error

    const m = byName(t.snapshot(start + 60_000));
    expect(m['app.db.qpm']).toBe(3);
    expect(m['app.db.slow']).toBe(1);
    expect(m['app.db.errors']).toBe(1);
    expect(m['query.SELECT reviews.qpm']).toBe(2);
    expect(m['query.SELECT reviews.slow']).toBe(1);
    expect(m['query.INSERT reviews.errors']).toBe(1);
  });

  it('모든 지표 이름은 64자 이하 — 아무리 긴 라우트라도', () => {
    t.snapshot();
    t.recordHttp('GET /api/some/very/long/route/segment/that/goes/on/and/on/[provider]/callback/again', 200, 10);
    t.recordQuery('SELECT * FROM a_ridiculously_long_table_name_that_should_still_be_truncated_safely_x', 10, true);
    // exec_ms 는 접미사가 가장 길다 — 이름 예산을 넘기면 여기서 먼저 걸린다
    t.recordPoolQuery('SELECT * FROM a_ridiculously_long_table_name_that_should_still_be_truncated_safely_x', 1, 9);
    for (const s of t.snapshot()) expect(s.metric.length, s.metric).toBeLessThanOrEqual(64);
  });

  it('풀 대기와 순수 실행을 따로 낸다 — "DB 가 느리다" 와 "슬롯이 없다" 를 가르려고', () => {
    const start = Date.now();
    t.snapshot(start);
    // 코드가 체감한 시간 300ms 인데 그중 실행은 4ms 였던 상황
    t.recordQuery('SELECT * FROM posts WHERE machine_id = $1', 300, true);
    t.recordPoolQuery('SELECT * FROM posts WHERE machine_id = $1', 290, 4);

    const m = byName(t.snapshot(start + 60_000));
    expect(m['app.db.p95_ms']).toBe(300); // 종전 지표는 뜻이 그대로다
    expect(m['app.db.wait_p95_ms']).toBe(290);
    expect(m['app.db.exec_p95_ms']).toBe(4);
    expect(m['query.SELECT posts.exec_ms']).toBe(4);
    // 전체 시간은 느린 쿼리로 세지만, 실행만 보면 느리지 않다
    expect(m['app.db.slow']).toBe(1);
    expect(m['app.db.exec_slow']).toBe(0);
  });

  it('풀 대기는 지문별로 나누지 않는다 — 붐빈 순간에 걸린 쿼리가 범인이 되면 안 된다', () => {
    t.snapshot();
    t.recordPoolQuery('SELECT * FROM posts', 290, 4);
    const names = t.snapshot().map((x) => x.metric);
    expect(names).toContain('app.db.wait_p95_ms');
    expect(names.filter((n) => n.startsWith('query.') && n.includes('wait'))).toEqual([]);
  });

  it('이벤트 루프 지연은 히스토그램이 있을 때만 — edge 번들에는 없다', () => {
    const g = globalThis as unknown as { __pulseLoopLag?: unknown };
    const saved = g.__pulseLoopLag;

    delete g.__pulseLoopLag;
    t.snapshot();
    expect(byName(t.snapshot())['app.loop.p95_ms']).toBeUndefined();

    let reset = 0;
    g.__pulseLoopLag = { percentile: () => 42_000_000, max: 91_000_000, reset: () => reset++ };
    t.snapshot();
    const m = byName(t.snapshot());
    expect(m['app.loop.p95_ms']).toBe(42); // ns → ms
    expect(m['app.loop.max_ms']).toBe(91);
    expect(reset).toBe(2); // 창마다 비운다 — 안 비우면 최댓값이 영원히 남는다

    if (saved === undefined) delete g.__pulseLoopLag;
    else g.__pulseLoopLag = saved;
  });

  it('창은 비워진다 — 다음 snapshot 에 라우트가 남지 않는다', () => {
    t.snapshot();
    t.recordHttp('GET /api/games', 200, 10);
    t.snapshot();
    const m = byName(t.snapshot());
    expect(m['app.http.rpm']).toBe(0);
    expect(Object.keys(m).filter((k) => k.startsWith('route.'))).toEqual([]);
  });

  it('숫자 세그먼트는 [id] 로 접힌다 — 매칭 안 된 실제 경로가 와도 카디널리티가 늘지 않는다', () => {
    t.snapshot();
    t.recordHttp('GET /api/arcades/12/reviews?x=1', 404, 3);
    t.recordHttp('GET /api/arcades/99/reviews', 404, 3);
    const routes = Object.keys(byName(t.snapshot())).filter((k) => k.startsWith('route.'));
    expect(routes).toContain('route.GET /api/arcades/[id]/reviews.rpm');
    expect(routes.filter((k) => k.endsWith('.rpm'))).toHaveLength(1);
  });
});

describe('withTelemetry — Db 어댑터를 감싼다', () => {
  // Db.query 는 제네릭이라 vi.fn 의 반환 타입과 맞지 않는다 — 대역은 통째로 캐스팅한다
  const fake = {
    query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
    exec: vi.fn(async () => {}),
    transaction: vi.fn(async (fn: (tx: { query: () => Promise<{ rows: never[] }> }) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: [] }) }),
    ),
  } as unknown as Db;

  it('query / exec / transaction 안의 tx.query 가 모두 잡힌다', async () => {
    t.snapshot();
    const db = t.withTelemetry(fake);
    await db.query('SELECT * FROM arcades');
    await db.exec('UPDATE players SET x = 1');
    await db.transaction((tx) => tx.query('DELETE FROM posts WHERE id = 1'));
    const m = byName(t.snapshot());
    expect(m['app.db.qpm']).toBeGreaterThan(0);
    expect(m['query.SELECT arcades.qpm']).toBeDefined();
    expect(m['query.UPDATE players.qpm']).toBeDefined();
    expect(m['query.DELETE posts.qpm']).toBeDefined();
  });

  it('실패한 쿼리는 에러로 세고 예외는 그대로 던진다', async () => {
    t.snapshot();
    const failing = { ...fake, query: vi.fn(async () => { throw new Error('boom'); }) } as unknown as Db;
    await expect(t.withTelemetry(failing).query('SELECT * FROM reviews')).rejects.toThrow('boom');
    expect(byName(t.snapshot())['query.SELECT reviews.errors']).toBe(1);
  });

  it('계측이 꺼져 있으면 원본을 그대로 돌려준다 — 비용 0', () => {
    delete process.env.PULSE_AGENT_KEY;
    expect(t.enabled()).toBe(false);
    expect(t.withTelemetry(fake)).toBe(fake);
    t.recordHttp('GET /api/games', 200, 1);
    expect(byName(t.snapshot())['app.http.rpm']).toBe(0);
  });
});

describe('flush — Pulse 수집 API 규약대로 보낸다', () => {
  it('POST /api/v1/metrics, Bearer 키, agentId + samples', async () => {
    t.snapshot();
    t.recordHttp('GET /api/games', 200, 12);
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    expect(await t.flush(fetchStub)).toBe(true);
    expect(calls[0].url).toBe('http://pulse.test/api/v1/metrics'); // 끝의 / 중복 없음
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer pk_test');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.agentId).toBe('arcade-finder');
    expect(body.samples.map((s: Sample) => s.metric)).toContain('route.GET /api/games.p95_ms');
  });

  it('Pulse 가 죽어 있어도 앱은 멀쩡하다 — false 만 돌려준다', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await t.flush(dead)).toBe(false);
  });
});
