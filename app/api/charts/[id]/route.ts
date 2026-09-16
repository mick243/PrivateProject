import { NextResponse } from 'next/server';
import { sessionPlayerId } from '@/lib/auth';
import { getChartDetail } from '@/lib/tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/charts/:id — 채보 상세 + 투표 분포
 *
 * 내 클리어·투표·평가 표시는 **세션 주인 기준**입니다. 예전에는 `?playerId=`
 * 로 받았는데, 그러면 번호만 바꿔가며 남이 무엇을 깼고 몇 점을 줬는지 훑을 수
 * 있었습니다. 로그인하지 않았으면 null — 개인 표시 없이 공개 정보만 나갑니다.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const chart = await getChartDetail(id, await sessionPlayerId(request));
  return chart
    ? NextResponse.json({ chart })
    : NextResponse.json({ error: '채보를 찾을 수 없습니다' }, { status: 404 });
}
