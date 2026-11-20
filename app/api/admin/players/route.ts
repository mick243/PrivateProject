import { NextResponse } from 'next/server';
import { handle } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { listPlayersForAdmin } from '@/lib/moderation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/players?q=닉네임|id — 관리자 계정 목록 (관리자 전용)
 *
 * q 가 없으면 처리 전 신고가 들어온 사람과 정지 중인 사람을 먼저 보여 줍니다 — 관리자가 할 일이
 * 있는 계정부터. 최대 50명.
 */
async function onGet(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const q = new URL(request.url).searchParams.get('q');
  return NextResponse.json(
    { players: await listPlayersForAdmin(q ? q.slice(0, 40) : null) },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export const GET = handle(onGet);
