import { json, REFERENCE_CACHE } from '@/lib/http';
import { badId, handle, notFound, parseId } from '@/lib/api-errors';
import { listSongCharts } from '@/lib/chart-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/charts/:id/siblings — 이 채보와 같은 곡의 채보들 (자기 자신 포함)
 *
 * 채보 패널의 '이 곡의 다른 채보' 링크용 (T-1). 버전을 구분하는 게임은 같은 버전 안에서만.
 * 곡 하나의 채보라 상한(40)에 닿을 일이 없지만 목록 규칙대로 둡니다 (GUIDELINES §4-4).
 */
async function onGet(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const song = await listSongCharts(id);
  if (!song) return notFound('채보를 찾을 수 없어요');
  return json(request, song, { headers: { 'Cache-Control': REFERENCE_CACHE } });
}

export const GET = handle(onGet);
