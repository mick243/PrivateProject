import { NextResponse } from 'next/server';
import { z } from 'zod';
import { badId, fail, forbidden, handle, parseBody, parseId } from '@/lib/api-errors';
import { requirePlayer } from '@/lib/auth';
import { NotClearedError, getChartDetail, getSettings, setVote } from '@/lib/tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  value: z.number(),
});

/**
 * 체감 난이도 투표 — `PUT` 으로 남기고 `DELETE` 로 거둡니다 (GUIDELINES §4-1).
 *
 * 예전에는 `POST` 하나가 `{value: number | null}` 을 받아 null 이면 취소였습니다.
 * 값이 실려야 하니 본문은 그대로지만, **취소는 메서드가 말하는 편이 낫습니다** —
 * "없앤다" 를 본문의 null 로 적으면 본문을 못 읽는 길(파싱 실패)에서 의도가 사라집니다.
 * 지침서가 정한 모양과 맞추는 것이기도 합니다 (2026-09-13 전체 점검에서 어긋남 확인).
 *
 * 클리어 기록이 없으면 403. 투표 범위는 tier_settings 에서 읽어 검증하므로
 * 스케일을 바꿔도 코드를 고칠 필요가 없습니다.
 *
 * 누구의 표인지는 세션이 정합니다. 본문의 playerId 를 믿던 동안에는 클리어
 * 게이트가 사실상 없는 것과 같았습니다 — 그 채보를 깬 아무 번호나 적으면
 * 통과했고, 등급이 표의 평균이라 서열표 전체를 혼자 흔들 수 있었습니다.
 */
async function save(chartId: number, playerId: number, value: number | null): Promise<NextResponse> {
  try {
    await setVote(playerId, chartId, value);
  } catch (err) {
    if (err instanceof NotClearedError) return forbidden(err.message);
    throw err;
  }
  return NextResponse.json({ chart: await getChartDetail(chartId, playerId) });
}

/** PUT /api/charts/:id/vote — 투표 `{value}` (같은 값을 여러 번 보내도 결과가 같습니다) */
async function onPut(request: Request, ctx: Ctx) {
  const chartId = parseId((await ctx.params).id);
  if (chartId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;

  const { value } = body.value;
  const { voteMin, voteMax } = await getSettings();
  if (value < voteMin || value > voteMax) {
    return fail(400, `투표값은 ${voteMin} ~ ${voteMax} 사이여야 합니다`);
  }

  return save(chartId, guard.playerId, value);
}

/** DELETE /api/charts/:id/vote — 투표 취소 (본문 없음) */
async function onDelete(request: Request, ctx: Ctx) {
  const chartId = parseId((await ctx.params).id);
  if (chartId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  return save(chartId, guard.playerId, null);
}

export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
