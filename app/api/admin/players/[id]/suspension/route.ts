import { NextResponse } from 'next/server';
import { badId, fail, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { suspendPlayer, SuspendError, unsuspendPlayer } from '@/lib/moderation';
import { suspendInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 계정 정지 (관리자 전용)
 *
 *   PUT    /api/admin/players/:id/suspension {days, reason}   정지 (days=null 이면 무기한). 다시 부르면 기간을 새로 잡음
 *   DELETE /api/admin/players/:id/suspension                  정지 풀기
 *
 * 정지되면 그 계정의 세션이 즉시 끊기고(lib/auth.ts getSession), 다시 로그인하면 정지 문구를 봅니다.
 * 관리자 계정은 정지할 수 없습니다.
 */
async function onPut(request: Request, ctx: Ctx) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();
  const body = await parseBody(request, suspendInputSchema);
  if (!body.ok) return body.response;
  try {
    const result = await suspendPlayer({
      playerId: id,
      days: body.value.days,
      reason: body.value.reason ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SuspendError) return fail(err.status, err.message);
    throw err;
  }
}

async function onDelete(request: Request, ctx: Ctx) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();
  return (await unsuspendPlayer(id))
    ? NextResponse.json({ suspended: false })
    : notFound('그런 계정이 없습니다');
}

export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
