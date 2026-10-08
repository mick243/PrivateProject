import { NextResponse } from 'next/server';
import { badId, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { requirePlayer } from '@/lib/auth';
import { deleteComment, listComments, upsertComment } from '@/lib/comments';
import { getChartDetail } from '@/lib/tier';
import { commentInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/charts/:id/comments — 채보 평가 목록 */
async function onGet(_request: Request, ctx: Ctx) {
  const chartId = parseId((await ctx.params).id);
  if (chartId === null) return badId();

  return NextResponse.json({ comments: await listComments(chartId) });
}

/**
 * POST /api/charts/:id/comments — 평가 등록/수정 (1인 1평가라 UPSERT)
 *
 * 투표(/vote)와 달리 클리어 게이트가 없습니다 — 못 깬 사람의 "여기서 막힌다"
 * 도 정보이기 때문입니다. 대신 응답의 comments[].cleared 로 구분됩니다.
 */
async function onPost(request: Request, ctx: Ctx) {
  const chartId = parseId((await ctx.params).id);
  if (chartId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const body = await parseBody(request, commentInputSchema);
  if (!body.ok) return body.response;

  // 채보 존재 확인 겸, 갱신된 상세를 그대로 돌려주기 위해 먼저 읽는다.
  if (!(await getChartDetail(chartId, null))) return notFound('채보를 찾을 수 없습니다');

  await upsertComment({ ...body.value, chartId, playerId: guard.playerId });
  const chart = await getChartDetail(chartId, guard.playerId);
  return NextResponse.json({ chart }, { status: 201 });
}

/** DELETE /api/charts/:id/comments — 본인 평가 삭제 (누구인지는 세션이 정합니다) */
async function onDelete(request: Request, ctx: Ctx) {
  const chartId = parseId((await ctx.params).id);
  if (chartId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const deleted = await deleteComment(chartId, guard.playerId);
  if (!deleted) return notFound('삭제할 평가가 없습니다');

  return NextResponse.json({ chart: await getChartDetail(chartId, guard.playerId) });
}

export const GET = handle(onGet);
export const POST = handle(onPost);
export const DELETE = handle(onDelete);
