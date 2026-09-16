import { json, REFERENCE_CACHE } from '@/lib/http';
import { listMachines } from '@/lib/arcades';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/machines — 기종 마스터 목록 (필터/등록 폼용)
 *
 * 마이그레이션으로만 바뀌는 값이라 캐시합니다. 세션에 따라 달라지는 것이 없습니다.
 */
export async function GET(request: Request) {
  const machines = await listMachines();
  return json(request, { machines }, { headers: { 'Cache-Control': REFERENCE_CACHE } });
}
