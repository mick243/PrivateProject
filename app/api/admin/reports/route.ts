import { NextResponse } from 'next/server';
import { handle, parseBody } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { listReportGroups, resolveReports } from '@/lib/moderation';
import type { ReportStatus } from '@/lib/moderation-types';
import { reportResolveSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: ReportStatus[] = ['open', 'actioned', 'dismissed'];

/**
 * 신고함 (관리자 전용)
 *
 *   GET /api/admin/reports?status=open|actioned|dismissed   대상마다 묶은 신고
 *   PUT /api/admin/reports {targetType, targetId, action}    그 대상의 처리 전 신고를 한꺼번에 처리
 *       action = delete(대상을 지움) | dismiss(기각)
 *
 * PUT 인 이유: 같은 요청을 두 번 보내도 결과가 같습니다(이미 처리된 신고는 다시 바꾸지 않고,
 * 이미 지운 대상은 그냥 넘어감).
 */
async function onGet(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const raw = new URL(request.url).searchParams.get('status');
  const status = STATUSES.includes(raw as ReportStatus) ? (raw as ReportStatus) : 'open';
  return NextResponse.json(
    { status, groups: await listReportGroups(status) },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function onPut(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const body = await parseBody(request, reportResolveSchema);
  if (!body.ok) return body.response;
  const result = await resolveReports({ ...body.value, adminId: guard.user.playerId });
  return NextResponse.json(result);
}

export const GET = handle(onGet);
export const PUT = handle(onPut);
