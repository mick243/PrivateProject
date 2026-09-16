import { NextResponse } from 'next/server';
import { requirePlayer } from '@/lib/auth';
import { getChartDetail, setClear } from '@/lib/tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 클리어 기록 — `PUT` 으로 표시하고 `DELETE` 로 지웁니다.
 *
 * 예전에는 `POST` 하나가 `{cleared: true|false}` 를 받았습니다. 값 자체는 멱등했지만
 * **지침서(GUIDELINES §4-1)가 정한 모양과 달랐습니다** — 그 문서는 상태를 바꾸는 요청을
 * `PUT`(켠다)·`DELETE`(끈다)로 하라고 적고 `setClear` 를 예로 들고 있는데, 정작 그 모양인
 * 것은 글 추천 하나뿐이었습니다. 지침서를 보고 `PUT` 을 부르면 405 가 났습니다
 * (2026-09-13 전체 점검에서 확인). 문서와 코드 중 코드를 옮깁니다.
 *
 * 해제하면 그 채보에 남긴 투표도 FK CASCADE 로 함께 사라집니다
 * (클리어하지 않은 사람의 투표가 남아 있으면 안 되므로).
 */
async function apply(request: Request, ctx: Ctx, cleared: boolean): Promise<NextResponse> {
  const chartId = Number((await ctx.params).id);
  if (!Number.isInteger(chartId) || chartId <= 0) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  // 본문을 읽지 않습니다 — 하려는 일이 메서드에 있습니다.
  await setClear(guard.playerId, chartId, cleared);
  return NextResponse.json({ chart: await getChartDetail(chartId, guard.playerId) });
}

/** PUT /api/charts/:id/clear — 클리어했다고 표시 */
export const PUT = (request: Request, ctx: Ctx) => apply(request, ctx, true);

/** DELETE /api/charts/:id/clear — 표시를 지움 (그 채보의 내 투표도 함께 사라집니다) */
export const DELETE = (request: Request, ctx: Ctx) => apply(request, ctx, false);
