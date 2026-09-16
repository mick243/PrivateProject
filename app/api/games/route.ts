import { json, REFERENCE_CACHE } from '@/lib/http';
import { listGames } from '@/lib/tier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/games — 서열표가 있는 게임(= tier_settings 가 등록된 기종) + 모드 목록 */
export async function GET(request: Request) {
  // 서열표가 등록된 기종은 마이그레이션으로만 늘어납니다 (lib/http.ts REFERENCE_CACHE).
  return json(request, { games: await listGames() }, { headers: { 'Cache-Control': REFERENCE_CACHE } });
}
