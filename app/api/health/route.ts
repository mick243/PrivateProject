import { NextResponse } from 'next/server';
import { getDb, getDbStatus } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — 외부 모니터링(Pulse 등)이 주기적으로 찌르는 상태 점검.
 *
 * 단순히 "살아 있다"가 아니라 **어느 DB 로 돌고 있는지**를 드러내는 것이 핵심이다.
 * lib/db.ts 는 PostgreSQL 에 못 붙으면 PGlite 사본으로 조용히 내려가는데, 그동안 쓴
 * 글·제보는 PostgreSQL 에 반영되지 않는다. 화면은 멀쩡하므로 서버 로그 말고는 알 길이
 * 없다 — 여기서 `checks.db_primary` 로 내보내 모니터링 룰이 잡게 한다.
 *
 * 응답 코드
 *   200 healthy    DB 응답 정상, 의도한 엔진으로 동작 (DATABASE_URL 없는 개발 기본값의 PGlite 포함)
 *   200 degraded   DB 응답은 되지만 PostgreSQL → PGlite 폴백 중. 서비스는 되므로 200 이다
 *   503 unhealthy  DB 조회 실패 — 로드밸런서·프로브가 내리도록
 *
 * `checks` 의 값은 'ok' | 'fail' 만 쓴다. Pulse 프로브가 항목마다 `check.<이름>` 지표(1/0)로
 * 편입하는 규약이라, 여기 항목을 하나 늘리면 대시보드에 차트가 하나 늘어난다.
 */
export async function GET() {
  const startedAt = Date.now();
  const checks: Record<'db' | 'db_primary', 'ok' | 'fail'> = { db: 'fail', db_primary: 'fail' };

  try {
    const db = await getDb();
    await db.query('SELECT 1');
    checks.db = 'ok';
  } catch (err) {
    console.error('[health] DB 조회 실패 —', err instanceof Error ? err.message : err);
  }

  // 폴백은 "내려온 이유" 가 있을 때만이다. DATABASE_URL 없이 PGlite 로 도는 개발 기본값은 정상.
  const status = getDbStatus();
  const onFallback = Boolean(status.fallbackReason);
  checks.db_primary = checks.db === 'ok' && !onFallback ? 'ok' : 'fail';

  const overall = checks.db !== 'ok' ? 'unhealthy' : onFallback ? 'degraded' : 'healthy';

  return NextResponse.json(
    {
      status: overall,
      checks,
      // 사유(fallbackReason)는 DB 호스트·포트가 섞여 있어 공개 응답에 싣지 않는다 — 서버 로그에 있다.
      db: { driver: status.driver, fallback: onFallback, ...(status.fallbackAt ? { fallbackAt: status.fallbackAt } : {}) },
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.APP_VERSION ?? 'dev',
      uptime_s: Math.floor(process.uptime()),
      latency_ms: Date.now() - startedAt,
    },
    {
      status: overall === 'unhealthy' ? 503 : 200,
      // 프록시·CDN 이 상태 응답을 캐시하면 죽은 뒤에도 한동안 "healthy" 가 나간다
      headers: { 'cache-control': 'no-store' },
    },
  );
}
