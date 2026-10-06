import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MetricValueWithName } from '@prometheus-io/client';

/**
 * Prometheus 내보내기 — **켜는 조건 · 지키는 문 · 쌓이는 값**을 고정합니다.
 *
 * Grafana 대시보드(monitoring/grafana/dashboards)와 알림 규칙(monitoring/prometheus/rules.yml)이
 * 지표 이름과 라벨을 그대로 쿼리합니다. 이름이나 라벨이 흔들리면 패널이 조용히 빕니다.
 * Pulse 쪽 규약은 tests/telemetry.test.ts 가 봅니다 — 여기서는 둘이 서로 간섭하지 않는지만 봅니다.
 */

const TOKEN = 'test-metrics-token-0123456789abcdef';

const prom = await import('@/lib/prometheus');
const t = await import('@/lib/telemetry');
const { GET } = await import('@/app/api/metrics/route');

const g = globalThis as unknown as { __prismaPool?: unknown };

beforeEach(() => {
  process.env.METRICS_TOKEN = TOKEN;
  delete process.env.PULSE_API_URL;
  delete process.env.PULSE_AGENT_KEY;
  prom._resetForTests();
  t._resetForTests();
  delete g.__prismaPool;
});
afterAll(() => {
  delete process.env.METRICS_TOKEN;
  prom._resetForTests();
  delete g.__prismaPool;
});

/** 레지스트리의 시계열 하나하나 — 히스토그램은 _bucket · _sum · _count 로 펼쳐진다 */
async function series(name: string): Promise<MetricValueWithName<string>[]> {
  const all = await prom.promMetrics()!.registry.getMetricsAsJSON();
  return all
    .flatMap((m) => (m.values as MetricValueWithName<string>[]).map((v) => ({ ...v, metricName: v.metricName ?? m.name })))
    .filter((v) => v.metricName === name);
}

const valueOf = (rows: MetricValueWithName<string>[], labels: Record<string, string>) =>
  rows.find((r) => Object.entries(labels).every(([k, v]) => (r.labels as Record<string, unknown>)[k] === v))?.value;

const scrape = (authorization?: string) =>
  GET(new Request('http://localhost/api/metrics', { headers: authorization ? { authorization } : {} }));

describe('켜는 조건 — METRICS_TOKEN', () => {
  it('토큰이 없으면 레지스트리도 기록 지점도 없다 — 측정 비용 0', () => {
    delete process.env.METRICS_TOKEN;
    expect(prom.promMetrics()).toBeNull();
    t.recordHttp('GET /api/games', 200, 10); // 던지지 않는다
    expect((globalThis as { __metricsSink?: unknown }).__metricsSink).toBeUndefined();
  });

  it('꺼져 있으면 /api/metrics 는 404 — 경로가 있다는 것도 드러내지 않는다', async () => {
    delete process.env.METRICS_TOKEN;
    const res = await scrape(`Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/metrics — 지키는 문', () => {
  it('Authorization 이 없으면 401 + WWW-Authenticate', async () => {
    const res = await scrape();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await res.json()).error).toBeTruthy();
  });

  it('토큰이 다르면 401 — 길이가 달라도 던지지 않는다', async () => {
    expect((await scrape('Bearer wrong')).status).toBe(401);
    expect((await scrape(`Bearer ${TOKEN}x`)).status).toBe(401);
    expect((await scrape(TOKEN)).status).toBe(401); // Bearer 접두어 없음
  });

  it('맞으면 200 Prometheus 텍스트 — 우리 지표와 Node 기본 지표가 함께', async () => {
    t.recordHttp('GET /api/games', 200, 12);
    const res = await scrape(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('# TYPE arcade_http_request_duration_seconds histogram');
    expect(text).toContain('# TYPE arcade_db_operation_duration_seconds histogram');
    expect(text).toContain('arcade_app_info{version=');
    expect(text).toContain('nodejs_eventloop_lag_p99_seconds');
    expect(text).toContain('process_resident_memory_bytes');
  });
});

describe('쌓이는 값 — 요청', () => {
  it('method · route · status 라벨, 단위는 초', async () => {
    prom.promMetrics();
    t.recordHttp('GET /api/arcades/[id]/reviews', 200, 120);
    t.recordHttp('GET /api/arcades/[id]/reviews', 200, 80);
    t.recordHttp('POST /api/arcades/[id]/reviews', 500, 30);

    const labels = { method: 'GET', route: '/api/arcades/[id]/reviews', status: '200' };
    expect(valueOf(await series('arcade_http_request_duration_seconds_count'), labels)).toBe(2);
    expect(valueOf(await series('arcade_http_request_duration_seconds_sum'), labels)).toBeCloseTo(0.2);
    expect(
      valueOf(await series('arcade_http_request_duration_seconds_count'), { method: 'POST', status: '500' }),
    ).toBe(1);
  });

  it('페이지도 라우트별로 받는다 — Pulse 는 /api 만 나누지만 라벨에는 이름 길이 예산이 없다', async () => {
    prom.promMetrics();
    t.recordHttp('GET /', 200, 50);
    t.recordHttp('GET /arcades/[id]', 200, 60);
    const rows = await series('arcade_http_request_duration_seconds_count');
    expect(valueOf(rows, { route: '/' })).toBe(1);
    expect(valueOf(rows, { route: '/arcades/[id]' })).toBe(1);
  });

  it('매칭 안 된 실제 경로는 숫자를 [id] 로 접고 쿼리스트링을 뗀다', async () => {
    prom.promMetrics();
    t.recordHttp('GET /api/arcades/12/reviews?x=1', 404, 3);
    t.recordHttp('GET /api/arcades/99/reviews', 404, 3);
    const rows = await series('arcade_http_request_duration_seconds_count');
    expect(valueOf(rows, { route: '/api/arcades/[id]/reviews', status: '404' })).toBe(2);
    expect(rows.filter((r) => String(r.labels.route).includes('12'))).toEqual([]);
  });

  it('라우트 종류는 150 에서 자른다 — 봇이 아무 경로나 찔러도 시계열이 불어나지 않는다', async () => {
    prom.promMetrics();
    for (let i = 0; i < 200; i++) t.recordHttp(`GET /wp-${String.fromCharCode(97 + (i % 26))}${i}.php`, 404, 1);
    const routes = new Set((await series('arcade_http_request_duration_seconds_count')).map((r) => r.labels.route));
    expect(routes.size).toBe(151); // 150 + '(other)'
    expect(routes.has('(other)')).toBe(true);
  });
});

describe('쌓이는 값 — DB', () => {
  it('Prisma 연산은 operation · outcome 라벨로', async () => {
    prom.promMetrics();
    t.recordOperation('findMany posts', 4, true);
    t.recordOperation('findMany posts', 6, true);
    t.recordOperation('create reviews', 2, false);
    const rows = await series('arcade_db_operation_duration_seconds_count');
    expect(valueOf(rows, { operation: 'findMany posts', outcome: 'ok' })).toBe(2);
    expect(valueOf(rows, { operation: 'create reviews', outcome: 'error' })).toBe(1);
  });

  it('250ms 버킷 경계가 있다 — 대시보드의 "느린 연산" 이 le="0.25" 로 센다', async () => {
    prom.promMetrics();
    t.recordOperation('findMany posts', 300, true);
    // 버킷의 le 는 JSON 에서 숫자다 (텍스트로는 le="0.25")
    const bucket = async (le: number) =>
      (await series('arcade_db_operation_duration_seconds_bucket')).find((b) => b.labels.le === le)?.value;
    expect(await bucket(0.25)).toBe(0);
    expect(await bucket(0.5)).toBe(1);
  });

  it('pg 풀 게이지는 긁는 순간의 풀에서 읽는다 — 풀이 아직 없으면 내지 않는다', async () => {
    prom.promMetrics();
    expect(await series('arcade_db_pool_connections')).toEqual([]);

    g.__prismaPool = { totalCount: 5, idleCount: 3, waitingCount: 2, options: { max: 10 } };
    const rows = await series('arcade_db_pool_connections');
    expect(valueOf(rows, { state: 'total' })).toBe(5);
    expect(valueOf(rows, { state: 'idle' })).toBe(3);
    expect(valueOf(rows, { state: 'waiting' })).toBe(2);
    expect(valueOf(rows, { state: 'max' })).toBe(10);
  });

  it('Pulse 가 꺼져 있어도 Db 어댑터를 감싼다 — Prometheus 만으로도 잰다', () => {
    prom.promMetrics();
    const fake = { query: async () => ({ rows: [] }), exec: async () => {}, transaction: async () => undefined };
    expect(t.enabled()).toBe(false);
    expect(t.withTelemetry(fake as never)).not.toBe(fake);
  });
});

describe('Pulse 와 함께 켰을 때', () => {
  it('Pulse 의 창 비우기(snapshot)가 Prometheus 누적값을 지우지 않는다', async () => {
    process.env.PULSE_API_URL = 'http://pulse.test/';
    process.env.PULSE_AGENT_KEY = 'pk_test';
    prom.promMetrics();
    t.recordHttp('GET /api/games', 200, 10);
    t.recordHttp('GET /api/games', 200, 10);

    const pulse = Object.fromEntries(t.snapshot().map((s) => [s.metric, s.value]));
    expect(pulse['route.GET /api/games.p95_ms']).toBe(10); // Pulse 도 그대로 받는다
    t.snapshot(); // 창이 비워져도

    const rows = await series('arcade_http_request_duration_seconds_count');
    expect(valueOf(rows, { route: '/api/games' })).toBe(2); // 누적은 남는다
  });
});
