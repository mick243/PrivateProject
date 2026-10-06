import { collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { MetricsSink } from './telemetry';

/**
 * Prometheus 내보내기 — `GET /api/metrics` 가 이 레지스트리를 텍스트로 내준다.
 *
 * 재는 지점은 새로 만들지 않는다. lib/telemetry.ts 가 Pulse 로 보내려고 이미 재는 곳
 * (라우트별 요청 · Prisma 연산)이 `__metricsSink` 를 함께 부른다. 다른 것은 모양이다 —
 * Pulse 는 30초 창마다 앱이 p95 를 계산해 보내고 창을 비우지만, Prometheus 는 누적
 * 카운터와 히스토그램 버킷을 긁어 가서 rate() · histogram_quantile() 로 **그쪽에서**
 * 계산한다. 그래서 여기는 아무것도 비우지 않는다. 둘은 함께 켤 수 있다.
 *
 * 켜는 법: `METRICS_TOKEN` (난수 32자 이상). 없으면 레지스트리를 만들지 않고, 측정 비용도
 * 0 이고, `/api/metrics` 는 404 다. 로컬 Prometheus · Grafana 는 monitoring/README.md.
 *
 * 지표 (이름의 단위는 Prometheus 관례대로 초)
 *   arcade_http_request_duration_seconds{method,route,status}   요청. _count 가 곧 요청 수
 *   arcade_db_operation_duration_seconds{operation,outcome}     Prisma 연산 · TypedSQL
 *   arcade_db_pool_connections{state}                           pg 풀 (total · idle · waiting · max)
 *   arcade_app_info{version}                                    늘 1 — 배포 판을 그래프에 겹쳐 보려고
 *   nodejs_* · process_*                                        기본 지표 (힙 · GC · 이벤트 루프 지연 · CPU)
 *
 * ⚠ 프로세스마다 따로 센다. `npm run start:cluster` 의 프록시(3000)로 긁으면 매번 다른
 *   인스턴스가 대답해 카운터가 들쭉날쭉해진다 — 내부 포트(3001 · 3002 …)를 각각 긁는다.
 */

/** 라우트 · 연산 종류 상한 — 넘어가면 '(other)'. 봇이 아무 경로나 찔러도 시계열이 불어나지 않게 */
const MAX_LABEL_VALUES = 150;

/** 요청: 5ms ~ 10s. k6 기준선(p95 159ms)이 가운데쯤 오도록 */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** DB: 1ms ~ 5s. 0.25 는 lib/telemetry.ts 의 SLOW_QUERY_MS — `le="0.25"` 밖이 곧 느린 쿼리 */
const DB_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** lib/prisma.ts 가 globalThis.__prismaPool 에 두는 pg.Pool 에서 읽는 칸만 */
type PoolLike = { totalCount: number; idleCount: number; waitingCount: number; options: { max?: number } };

export type PromMetrics = { registry: Registry };

/**
 * globalThis 에 두는 이유는 lib/telemetry.ts 의 상태와 같다 — Next 가 instrumentation 번들과
 * 앱 번들을 따로 만들어서, 모듈 스코프에 두면 기록하는 쪽과 `/api/metrics` 가 다른 레지스트리를
 * 본다. dev HMR 로 다시 평가돼도 같은 이름을 두 번 등록하지 않는다.
 */
const g = globalThis as unknown as { __promMetrics?: PromMetrics; __metricsSink?: MetricsSink };

export function metricsEnabled(): boolean {
  return Boolean(process.env.METRICS_TOKEN);
}

/** 라벨 값 종류를 상한에서 자른다. 이미 본 값은 상한을 넘어도 그대로 */
function capped(seen: Set<string>, value: string): string {
  if (seen.has(value)) return value;
  if (seen.size >= MAX_LABEL_VALUES) return '(other)';
  seen.add(value);
  return value;
}

function create(): PromMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const http = new Histogram({
    name: 'arcade_http_request_duration_seconds',
    help: '요청 하나의 처리 시간 (Next 의 BaseServer.handleRequest 스팬). route 는 라우트 패턴',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });

  const dbOp = new Histogram({
    name: 'arcade_db_operation_duration_seconds',
    help: 'Prisma 연산 하나가 코드에서 체감된 시간 — 풀 대기와 이벤트 루프 지연을 포함한다',
    labelNames: ['operation', 'outcome'] as const,
    buckets: DB_BUCKETS,
    registers: [registry],
  });

  new Gauge({
    name: 'arcade_db_pool_connections',
    help: 'pg 풀 커넥션 수 — waiting 이 0 보다 크면 슬롯이 모자라 요청이 줄 서 있다 (PG_POOL_MAX)',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      // 첫 DB 요청 전에는 풀이 아직 없다 — 그때는 아무것도 내지 않는다
      const pool = (globalThis as unknown as { __prismaPool?: PoolLike }).__prismaPool;
      if (!pool) return;
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
      this.set({ state: 'max' }, pool.options.max ?? 10);
    },
  });

  new Gauge({
    name: 'arcade_app_info',
    help: '늘 1. version 은 /api/health 의 version 과 같은 값',
    labelNames: ['version'] as const,
    registers: [registry],
  }).set({ version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.APP_VERSION ?? 'dev' }, 1);

  const routes = new Set<string>();
  const operations = new Set<string>();
  g.__metricsSink = {
    http(method, route, status, ms) {
      http.observe({ method, route: capped(routes, route), status: String(status) }, ms / 1000);
    },
    operation(key, ms, ok) {
      dbOp.observe({ operation: capped(operations, key), outcome: ok ? 'ok' : 'error' }, ms / 1000);
    },
  };

  return { registry };
}

/** 켜져 있으면 레지스트리(처음이면 만들면서 기록 지점도 연결), 꺼져 있으면 null */
export function promMetrics(): PromMetrics | null {
  if (!metricsEnabled()) return null;
  return (g.__promMetrics ??= create());
}

/** 테스트용 — 레지스트리와 기록 지점을 떼어 낸다 */
export function _resetForTests(): void {
  g.__promMetrics?.registry.clear();
  g.__promMetrics = undefined;
  g.__metricsSink = undefined;
}
