import { createHash, timingSafeEqual } from 'node:crypto';
import { fail, handle, notFound } from '@/lib/api-errors';
import { promMetrics } from '@/lib/prometheus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics — Prometheus 가 긁어 가는 지표 (lib/prometheus.ts).
 *
 * 응답 코드
 *   404  METRICS_TOKEN 이 없음 — 꺼진 환경에서는 이 경로가 있다는 것도 드러내지 않는다
 *   401  `Authorization: Bearer <METRICS_TOKEN>` 이 아님
 *   200  Prometheus 텍스트 형식
 *
 * 토큰을 받는 이유: 이 응답에는 라우트 목록 · 라우트별 트래픽 · DB 연산 이름이 다 들어 있다.
 * 프록시(Caddy · start-cluster) 뒤에서 그대로 열리면 밖에서 읽힌다.
 */
export const GET = handle(async (request: Request) => {
  const metrics = promMetrics();
  if (!metrics) return notFound('찾을 수 없습니다');

  if (!authorized(request.headers.get('authorization'), process.env.METRICS_TOKEN ?? '')) {
    const res = fail(401, '지표 토큰이 맞지 않습니다');
    res.headers.set('www-authenticate', 'Bearer');
    return res;
  }

  return new Response(await metrics.registry.metrics(), {
    headers: { 'content-type': metrics.registry.contentType, 'cache-control': 'no-store' },
  });
});

/** 해시끼리 견준다 — 길이가 같아져 timingSafeEqual 이 던지지 않고, 길이도 새지 않는다 */
function authorized(header: string | null, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token));
}
