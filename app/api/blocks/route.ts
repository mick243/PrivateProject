import { NextResponse } from 'next/server';
import { badId, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { requirePlayer } from '@/lib/auth';
import { listBlocked, setBlock } from '@/lib/moderation';
import { blockInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 차단 — 차단한 사람의 글 · 댓글 · 리뷰 · 채보 평가를 **내 화면에서** 가립니다 (로그인 필요).
 *
 *   GET    /api/blocks               내가 차단한 사람 목록
 *   PUT    /api/blocks {playerId}    차단 (이미 차단했으면 그대로 — 멱등)
 *   DELETE /api/blocks?playerId=N    차단 풀기 (DELETE 에는 본문을 싣지 않습니다 — GUIDELINES.md 4-1)
 *
 * 상대에게는 알리지 않고, 상대의 화면은 바뀌지 않습니다. 가리기는 화면이 합니다
 * (lib/use-blocks.ts) — 목록마다 SQL 에 조건을 넣으면 캐시하는 목록(게시판)이 사람마다 갈립니다.
 */
async function onGet(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;
  return NextResponse.json(
    { blocked: await listBlocked(guard.playerId) },
    { headers: { 'cache-control': 'no-store' } },
  );
}

async function onPut(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;
  const body = await parseBody(request, blockInputSchema);
  if (!body.ok) return body.response;
  const ok = await setBlock(guard.playerId, body.value.playerId, true);
  return ok ? NextResponse.json({ blocked: true }) : notFound('차단할 사용자를 찾지 못했습니다');
}

async function onDelete(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;
  const id = parseId(new URL(request.url).searchParams.get('playerId'));
  if (id === null) return badId();
  await setBlock(guard.playerId, id, false);
  return NextResponse.json({ blocked: false });
}

export const GET = handle(onGet);
export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
