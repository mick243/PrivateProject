import { json, REFERENCE_CACHE } from '@/lib/http';
import { fail, handle } from '@/lib/api-errors';
import { normalizeChartQuery, searchChartSongs } from '@/lib/chart-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/charts/search?machineId=1&q=night  (버전이 있는 게임은 &versionId=1 도)
 *
 * 서열표 곡 검색 — 그 게임의 **모든 레벨**에서 곡 이름으로 찾고, 곡마다 채보(모드 · 난이도 ·
 * 레벨)를 실어 보냅니다. 화면은 채보를 고르면 그 레벨로 건너가 채보를 엽니다 (T-1).
 *
 * 곡 20개 상한 · 제목 → id 순 (GUIDELINES §4-4). 개인 표시가 없는 참조 데이터라 캐시합니다.
 */
async function onGet(request: Request) {
  const { searchParams } = new URL(request.url);
  const machineId = Number(searchParams.get('machineId'));
  if (!Number.isInteger(machineId) || machineId <= 0) {
    return fail(400, '게임을 먼저 골라 주세요');
  }
  const q = normalizeChartQuery(searchParams.get('q'));
  if (q === null) return fail(400, '찾을 곡 이름을 적어 주세요');

  const rawVersion = searchParams.get('versionId');
  const versionId =
    rawVersion !== null && Number.isInteger(Number(rawVersion)) ? Number(rawVersion) : null;

  const songs = await searchChartSongs({ machineId, versionId, q });
  return json(request, { q, songs }, { headers: { 'Cache-Control': REFERENCE_CACHE } });
}

export const GET = handle(onGet);
