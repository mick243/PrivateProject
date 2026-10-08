import { NextResponse } from 'next/server';
import { handle } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { markAllAlertsRead } from '@/lib/ops-alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/ops/alerts/read — 안 읽은 운영 알림을 모두 읽음으로 (관리자 전용).
 *
 * 종 아이콘의 목록을 열면 부릅니다. 원하는 상태("다 읽었다")를 받으므로 두 번 불러도 같습니다
 * (GUIDELINES.md §4-1). 본문은 없습니다.
 */
export const PUT = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const updated = await markAllAlertsRead();
  return NextResponse.json({ updated });
});
