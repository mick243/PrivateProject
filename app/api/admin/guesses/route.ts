import { NextResponse } from 'next/server';
import { badId, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { approveGuess, listGuessesForReview, rejectGuess } from '@/lib/moderation';
import { guessKeySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI 보유 기종 추정 검수 (관리자 전용)
 *
 *   GET    /api/admin/guesses                              검수 대기 중인 추정 (lib/machine-guess.ts 가 쌓은 것)
 *   PUT    /api/admin/guesses {arcadeId, machineId}        승인 — 보유 기종에 넣고(기체 1대) 추정은 지움
 *   DELETE /api/admin/guesses?arcadeId=N&machineId=M       버리기
 *
 * 예전에는 추정이 상세 화면에 "AI가 찾은 기종" 으로만 뜨고, 확정하려면 오락실 수정 폼에서 손으로
 * 다시 넣어야 했습니다 (2026-11-20 문제점 조사).
 */
async function onGet(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  return NextResponse.json(
    { guesses: await listGuessesForReview() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function onPut(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const body = await parseBody(request, guessKeySchema);
  if (!body.ok) return body.response;
  return (await approveGuess(body.value.arcadeId, body.value.machineId))
    ? NextResponse.json({ approved: true })
    : notFound('그 추정을 찾지 못했습니다 (이미 처리됐을 수 있습니다)');
}

async function onDelete(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const sp = new URL(request.url).searchParams;
  const arcadeId = parseId(sp.get('arcadeId'));
  const machineId = parseId(sp.get('machineId'));
  if (arcadeId === null || machineId === null) return badId();
  await rejectGuess(arcadeId, machineId);
  return NextResponse.json({ rejected: true });
}

export const GET = handle(onGet);
export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
