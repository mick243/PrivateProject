import { NextResponse } from 'next/server';
import { json } from '@/lib/http';
import { badId, badJson, handle, invalid, notFound, parseId } from '@/lib/api-errors';
import { deleteArcade, getArcade, updateArcade } from '@/lib/arcades';
import { requireAdmin } from '@/lib/auth';
import { arcadeInputSchema, formatIssues } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () => notFound('오락실을 찾을 수 없습니다');

async function onGet(request: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const arcade = await getArcade(id);
  return arcade ? json(request, { arcade }) : NOT_FOUND();
}

/**
 * PUT /api/arcades/:id — 오락실 수정 (관리자 전용)
 *
 * 여기서 보유 기종·대수도 함께 바뀝니다. 제보의 자동 반영을 되돌리는 유일한
 * 경로이기도 해서(lib/reports.ts deleteReport 주석), 아무나 열 수 없습니다.
 */
async function onPut(request: Request, ctx: Ctx) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badJson();
  }

  const parsed = arcadeInputSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error);
  }

  const arcade = await updateArcade(id, parsed.data);
  return arcade ? NextResponse.json({ arcade }) : NOT_FOUND();
}

/** DELETE /api/arcades/:id — 삭제 (관리자 전용). 제보·리뷰가 CASCADE 로 함께 사라집니다 */
async function onDelete(request: Request, ctx: Ctx) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const deleted = await deleteArcade(id);
  return deleted ? new NextResponse(null, { status: 204 }) : NOT_FOUND();
}

/**
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
