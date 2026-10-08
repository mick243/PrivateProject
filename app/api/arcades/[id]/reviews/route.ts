import { NextResponse } from 'next/server';
import { badId, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { getArcade } from '@/lib/arcades';
import { requirePlayer } from '@/lib/auth';
import { deleteReview, listReviews, upsertReview } from '@/lib/reviews';
import { reviewInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/arcades/:id/reviews */
async function onGet(_request: Request, ctx: Ctx) {
  const arcadeId = parseId((await ctx.params).id);
  if (arcadeId === null) return badId();

  return NextResponse.json({ reviews: await listReviews(arcadeId) });
}

/**
 * POST /api/arcades/:id/reviews — 리뷰 등록/수정 (1인 1리뷰라 UPSERT)
 * 평점 캐시가 갱신되므로 오락실도 함께 돌려줍니다.
 *
 * 누구의 리뷰인지는 세션이 정합니다 — 1인 1리뷰라 본문의 playerId 를 믿으면
 * 그 한 줄을 남의 것으로 덮어쓸 수 있습니다.
 */
async function onPost(request: Request, ctx: Ctx) {
  const arcadeId = parseId((await ctx.params).id);
  if (arcadeId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const body = await parseBody(request, reviewInputSchema);
  if (!body.ok) return body.response;

  if (!(await getArcade(arcadeId))) return notFound('오락실을 찾을 수 없습니다');

  const review = await upsertReview({ ...body.value, arcadeId, playerId: guard.playerId });
  return NextResponse.json(
    { review, reviews: await listReviews(arcadeId), arcade: await getArcade(arcadeId) },
    { status: 201 },
  );
}

/** DELETE /api/arcades/:id/reviews — 본인 리뷰 삭제 (누구인지는 세션이 정합니다) */
async function onDelete(request: Request, ctx: Ctx) {
  const arcadeId = parseId((await ctx.params).id);
  if (arcadeId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const deleted = await deleteReview(arcadeId, guard.playerId);
  if (!deleted) return notFound('삭제할 리뷰가 없습니다');

  return NextResponse.json({
    reviews: await listReviews(arcadeId),
    arcade: await getArcade(arcadeId),
  });
}

export const GET = handle(onGet);
export const POST = handle(onPost);
export const DELETE = handle(onDelete);
