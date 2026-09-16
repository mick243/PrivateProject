import { NextResponse } from 'next/server';
import { requirePlayer } from '@/lib/auth';
import { getChartDetail, setSpecial } from '@/lib/tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 특수 패턴 표시 — `PUT` 으로 켜고 `DELETE` 로 끕니다 (GUIDELINES §4-1).
 * 예전에는 `POST` 가 `{special: boolean}` 을 받았습니다 — clear 라우트와 같은 이유로 옮겼습니다.
 *
 * 클리어 기록은 요구하지 않습니다 (평가란과 같은 이유 — 못 깬 사람도 기믹은
 * 보입니다). 누구인지는 세션이 정하고, 표시한 사람은 `special_marks` 에 남아
 * 합의 인원으로 셉니다.
 *
 * ⚠ 투표·평가와 달리 **한 사람이 켜면 모두에게 그렇게 보입니다.** 이제 최소한
 *   로그인한 사람만 켤 수 있지만, 계정 하나면 여전히 충분합니다. 남용이 문제가
 *   되면 관리자 전용으로 좁히거나 합의 인원(min_votes 처럼)을 올려야 합니다.
 */
async function apply(request: Request, ctx: Ctx, special: boolean): Promise<NextResponse> {
  const chartId = Number((await ctx.params).id);
  if (!Number.isInteger(chartId) || chartId <= 0) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  await setSpecial(guard.playerId, chartId, special);
  return NextResponse.json({ chart: await getChartDetail(chartId, guard.playerId) });
}

/** PUT /api/charts/:id/special — 특수 패턴으로 표시 */
export const PUT = (request: Request, ctx: Ctx) => apply(request, ctx, true);

/** DELETE /api/charts/:id/special — 표시를 뺌 */
export const DELETE = (request: Request, ctx: Ctx) => apply(request, ctx, false);
