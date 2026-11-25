import { NextResponse } from 'next/server';
import { handle, notFound, parseBody } from '@/lib/api-errors';
import { listInfoReportsForReview, resolveInfoReport } from '@/lib/arcade-info-reports';
import { requireAdmin } from '@/lib/auth';
import { arcadeInfoResolveSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 오락실 정보 고침 제보 검수 (관리자 전용 · migrate-087)
 *
 *   GET /api/admin/info-reports                                       열린 제보 (오래된 것부터)
 *   PUT /api/admin/info-reports {id, action: 'apply', hoursText?}     반영 — 영업시간은 오락실에 넣음
 *   PUT /api/admin/info-reports {id, action: 'dismiss'}               버리기
 *
 * 문 닫음 · 옮김 · 그 밖은 apply 해도 오락실을 바꾸지 않습니다 — 확인했다는 표시만 남고, 지우기 ·
 * 옮기기는 오락실 수정 화면에서 합니다 (lib/arcade-info-reports.ts resolveInfoReport).
 */
async function onGet(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  return NextResponse.json(
    { reports: await listInfoReportsForReview() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function onPut(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const body = await parseBody(request, arcadeInfoResolveSchema);
  if (!body.ok) return body.response;
  const done = await resolveInfoReport({ ...body.value, adminId: guard.user.playerId });
  return done
    ? NextResponse.json({ resolved: body.value.action })
    : notFound('그 제보를 찾지 못했어요. 이미 처리됐을 수 있어요');
}

export const GET = handle(onGet);
export const PUT = handle(onPut);
