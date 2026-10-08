import { NextResponse } from 'next/server';
import { handle } from '@/lib/api-errors';
import { pingDatabase } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — 외부 모니터링(Pulse 등)이 주기적으로 찌르는 상태 점검.
 *
 * 응답 코드
 *   200 healthy    DB 응답 정상
 *   503 unhealthy  DB 조회 실패 — 로드밸런서·프로브가 내리도록
 *
 * 예전에는 `degraded`(PostgreSQL → PGlite 폴백 중)가 있었습니다. 앱이 Prisma 로 옮겨
 * 폴백 자체가 없어졌으므로(lib/prisma.ts) 그 상태도 없습니다 — DB 에 못 붙으면 그냥
 * unhealthy 입니다. `checks.db_primary` 키는 모니터링 룰이 보는 이름이라 남겨 두고,
 * 이제 `db` 와 같은 값입니다.
 *
 * `checks` 의 값은 'ok' | 'fail' 만 씁니다. Pulse 프로브가 항목마다 `check.<이름>` 지표(1/0)로
 * 편입하는 규약이라, 여기 항목을 하나 늘리면 대시보드에 차트가 하나 늘어납니다.
 */
async function onGet() {
  const startedAt = Date.now();
  const checks: Record<'db' | 'db_primary', 'ok' | 'fail'> = { db: 'fail', db_primary: 'fail' };

  try {
    await pingDatabase();
    checks.db = 'ok';
    checks.db_primary = 'ok';
  } catch (err) {
    console.error('[health] DB 조회 실패 —', err instanceof Error ? err.message : err);
  }

  const overall = checks.db === 'ok' ? 'healthy' : 'unhealthy';

  return NextResponse.json(
    {
      status: overall,
      checks,
      db: { driver: 'postgres', client: 'prisma', fallback: false },
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.APP_VERSION ?? 'dev',
      uptime_s: Math.floor(process.uptime()),
      latency_ms: Date.now() - startedAt,
    },
    {
      status: overall === 'healthy' ? 200 : 503,
      // 프록시·CDN 이 상태 응답을 캐시하면 죽은 뒤에도 한동안 "healthy" 가 나간다
      headers: { 'cache-control': 'no-store' },
    },
  );
}

export const GET = handle(onGet);
