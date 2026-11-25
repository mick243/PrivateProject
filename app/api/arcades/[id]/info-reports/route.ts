import { NextResponse } from 'next/server';
import { badId, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { infoSentMessage } from '@/lib/arcade-info-report-types';
import { createInfoReport } from '@/lib/arcade-info-reports';
import { getArcade } from '@/lib/arcades';
import { requirePlayer } from '@/lib/auth';
import { arcadeInfoReportInputSchema } from '@/lib/validation';
import { checkWriteLimit } from '@/lib/write-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/arcades/:id/info-reports — "정보가 달라요" (로그인 필요 · migrate-087)
 *
 *   본문 { kind: 'hours' | 'closed' | 'moved' | 'other', hoursText?, detail? }
 *   응답 201 { id, updated, message }
 *
 * 바로 반영하지 않고 관리자 검수 목록(/api/admin/info-reports)에 쌓입니다. 같은 사람이 같은
 * 오락실에 같은 종류를 다시 보내면 앞의 것을 고칩니다(updated: true).
 *
 * 로그인을 요구하는 이유: 기종 제보와 달리 이 제보는 관리자가 한 줄씩 읽습니다. 익명이면
 * 같은 사람이 낸 것인지 가를 수 없고, 고쳐 보내기(updated)도 할 수 없습니다.
 */
async function onPost(request: Request, ctx: Ctx) {
  const arcadeId = parseId((await ctx.params).id);
  if (arcadeId === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const body = await parseBody(request, arcadeInfoReportInputSchema);
  if (!body.ok) return body.response;

  if (!(await getArcade(arcadeId))) return notFound('오락실을 찾을 수 없어요. 지워졌을 수 있어요');

  const limited = await checkWriteLimit('info', guard.playerId);
  if (limited) return limited;

  const saved = await createInfoReport({ ...body.value, arcadeId, playerId: guard.playerId });
  return NextResponse.json(
    { ...saved, message: infoSentMessage(body.value.kind, saved.updated) },
    { status: 201 },
  );
}

export const POST = handle(onPost);
