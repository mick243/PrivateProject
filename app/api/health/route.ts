import { NextResponse } from 'next/server';
import { handle } from '@/lib/api-errors';
import { checkUploadStorage, pingDatabase } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Check = 'ok' | 'fail';

/**
 * GET /api/health — 외부 모니터링(Pulse 등)이 주기적으로 찌르는 상태 점검.
 *
 * 응답 코드
 *   200 healthy    전부 정상
 *   200 degraded   DB 는 정상인데 첨부를 받을 수 없음 — 업로드 폴더에 못 쓰거나(`uploads`)
 *                  디스크 여유가 모자람(`disk`). 지도 · 서열표 · 글 읽기는 그대로 됩니다.
 *   503 unhealthy  DB 조회 실패 — 로드밸런서·프로브가 내리도록
 *
 * degraded 를 503 으로 내지 않는 이유: start-cluster 의 무중단 재기동은 새 인스턴스가 200 을
 * 줄 때까지 기다렸다가 바꿉니다(scripts/start-cluster.mjs). 디스크가 찼을 때 503 을 내면
 * 디스크를 비우는 배포조차 들어가지 못합니다. 알림은 `checks.uploads` · `checks.disk` 로 받습니다.
 * (2026-09-13 QA H7 이 "degraded → 503" 을 권했던 것은 그때의 degraded 가 **가짜 DB 로 응답하는**
 * PGlite 폴백이었기 때문입니다 — 그 상태는 Prisma 이관으로 없어졌습니다.)
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
  const checks: Record<'db' | 'db_primary' | 'uploads' | 'disk', Check> = {
    db: 'fail',
    db_primary: 'fail',
    uploads: 'fail',
    disk: 'fail',
  };

  // DB 와 저장소는 서로 기다릴 이유가 없어 함께 봅니다
  const [, storage] = await Promise.all([
    pingDatabase().then(
      () => {
        checks.db = 'ok';
        checks.db_primary = 'ok';
      },
      (err: unknown) => {
        console.error('[health] DB 조회 실패 —', err instanceof Error ? err.message : err);
      },
    ),
    checkUploadStorage(),
  ]);
  checks.uploads = storage.uploads;
  checks.disk = storage.disk;

  const overall =
    checks.db !== 'ok'
      ? 'unhealthy'
      : checks.uploads === 'ok' && checks.disk === 'ok'
        ? 'healthy'
        : 'degraded';

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
      status: overall === 'unhealthy' ? 503 : 200,
      // 프록시·CDN 이 상태 응답을 캐시하면 죽은 뒤에도 한동안 "healthy" 가 나간다
      headers: { 'cache-control': 'no-store' },
    },
  );
}

export const GET = handle(onGet);
