import { NextResponse } from 'next/server';
import { badId, handle, notFound, parseId } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { deleteReport } from '@/lib/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/reports/:id — 제보 삭제 (관리자 전용)
 *
 * 제보에는 수정이 없습니다. 장난 제보나 메모에 섞인 개인정보를 지울 방법이
 * 이것뿐이라 관리자에게만 엽니다 — 작성자 본인에게도 열지 않습니다.
 * "내 제보 지우기"가 있으면 없어졌어요 임계값을 채운 뒤 흔적만 지우는 길이
 * 열립니다 (자동 반영은 되돌아가지 않으므로 lib/reports.ts deleteReport 참고).
 */
async function onDelete(request: Request, ctx: Ctx) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const deleted = await deleteReport(id);
  return deleted ? new NextResponse(null, { status: 204 }) : notFound('제보를 찾을 수 없습니다');
}

export const DELETE = handle(onDelete);
