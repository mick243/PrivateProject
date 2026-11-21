import { NextResponse } from 'next/server';
import { z } from 'zod';
import { badId, fail, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { suspendPlayer, SuspendError, unsuspendPlayer } from '@/lib/moderation';
import { suspendInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 정지에는 사유가 꼭 있어야 합니다 — 정지된 사람은 다시 로그인할 때 이 사유를 봅니다.
 * 2026-11-20 UX 시험(Ad-2)에서 사유 없이 정지가 되어 사용자가 빈 사유를 봤습니다.
 * 공용 스키마(lib/validation.ts)는 그대로 두고 이 라우트에서만 조입니다.
 */
const suspendRequestSchema = suspendInputSchema.extend({
  reason: z
    .string({ error: '정지 사유를 써 주세요. 정지된 사람에게 보여요' })
    .trim()
    .min(1, '정지 사유를 써 주세요. 정지된 사람에게 보여요')
    .max(200, '사유는 200자까지 쓸 수 있어요'),
});

/**
 * 계정 정지 (관리자 전용)
 *
 *   PUT    /api/admin/players/:id/suspension {days, reason}   정지 (days=null 이면 무기한, reason 필수). 다시 부르면 기간을 새로 잡음
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
  const body = await parseBody(request, suspendRequestSchema, 'first');
  if (!body.ok) return body.response;
  try {
    const result = await suspendPlayer({
      playerId: id,
      days: body.value.days,
      reason: body.value.reason,
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
    : notFound('계정을 찾을 수 없어요. 탈퇴했을 수 있어요');
}

export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
