import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listEmoticonsForAdmin, normalizeAdminQuery } from '@/lib/emoticons';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/emoticons/admin?status=live|deleted|all&q=&page=&pageSize= — 관리 목록. **관리자만.**
 *
 * 공개 목록(GET /api/emoticons)과 갈라 둔 이유: 그쪽은 고르는 칸이 부르는
 * 가벼운 표(id·이름)이고 지운 것을 절대 담지 않습니다. 여기는 지운 것·올린 사람·
 * 크기까지 보이는 관리자용이라 **같은 주소에 관리자면 더 보여 주는** 식으로
 * 섞으면 언젠가 조건을 빠뜨려 지운 것이 고르는 칸에 뜹니다.
 *
 * 응답 `{ rows, total, page, pageSize }` — 페이지 번호는 서버가 다듬은 값으로
 * 돌려줍니다. 화면이 보낸 값이 잘려도(페이지 크기 상한) 화면이 그대로 따라옵니다.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const sp = new URL(request.url).searchParams;
  const query = normalizeAdminQuery({
    page: sp.get('page') ?? undefined,
    pageSize: sp.get('pageSize') ?? undefined,
    status: sp.get('status') ?? undefined,
    q: sp.get('q') ?? undefined,
  });
  const { rows, total } = await listEmoticonsForAdmin(query);
  return NextResponse.json({ rows, total, page: query.page, pageSize: query.pageSize });
}
