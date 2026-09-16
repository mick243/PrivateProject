import { NextResponse } from 'next/server';
import { json } from '@/lib/http';
import { badJson, handle, invalid } from '@/lib/api-errors';
import { createArcade, listArcades } from '@/lib/arcades';
import { requireAdmin } from '@/lib/auth';
import { arcadeInputSchema, parseListQuery } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/arcades
 *   ?q=          이름/주소 검색어
 *   &machines=1,3  선택 기종을 모두 보유한 곳만
 *   &lat=&lng=&radius=  반경(km) 검색 + 거리 정렬
 */
async function onGet(request: Request) {
  const { searchParams } = new URL(request.url);
  const arcades = await listArcades(parseListQuery(searchParams));
  // 목록 전체를 한 번에 내보내는 자리라 앱에서 가장 큰 응답입니다 — 압축은 lib/http.ts.
  return json(request, { arcades });
}

/**
 * POST /api/arcades — 오락실 등록 (관리자 전용)
 *
 * 오락실 레코드 자체를 만드는 일은 관리자만 합니다. 크라우드소싱은 그 위에
 * 얹히는 제보(있어요/없어졌어요/대기/컨디션)와 리뷰로 굴러갑니다 — 이름·주소·
 * 좌표는 한 번 틀리면 지도에서 엉뚱한 곳이 되고, 되돌릴 사람이 없습니다.
 */
async function onPost(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

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

  const arcade = await createArcade(parsed.data);
  return NextResponse.json({ arcade }, { status: 201 });
}

/**
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
export const POST = handle(onPost);
