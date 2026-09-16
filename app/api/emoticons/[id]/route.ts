import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import {
  deleteEmoticon,
  EmoticonNameTakenError,
  normalizeName,
  renameEmoticon,
  restoreEmoticon,
} from '@/lib/emoticons';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * DELETE /api/emoticons/:id — 목록에서 뺍니다 (soft delete). **관리자만.**
 *
 * 이미 쓰인 댓글의 `[[emo:N]]` 은 남습니다 — 남의 글을 고치지 않습니다. 그 자리는
 * 화면이 이름표로 바꿔 그립니다(components/EmoticonText.tsx).
 * 행도 파일도 지우지 않습니다 (lib/emoticons.ts deleteEmoticon 주석). 되살리기는
 * PATCH { restore: true }.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const id = parseId((await ctx.params).id);
  if (id === null) return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });

  if (!(await deleteEmoticon(id))) {
    return NextResponse.json({ error: '이모티콘을 찾을 수 없습니다' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/emoticons/:id — 관리 페이지의 두 동작. **관리자만.**
 *
 *   { name: "새 이름" }   살아 있는 이모티콘의 이름을 바꿉니다
 *   { restore: true }     지운 것을 되살립니다
 *
 * 둘을 한 요청에 섞지 않습니다 — 되살리면서 이름도 바꾸는 화면은 없고, 섞이면
 * "이름은 바뀌었는데 되살리기는 실패" 같은 반쪽 결과를 설명해야 합니다.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const id = parseId((await ctx.params).id);
  if (id === null) return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });

  let body: { name?: unknown; restore?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '본문을 읽을 수 없습니다' }, { status: 400 });
  }

  try {
    if (body.restore === true) {
      if (!(await restoreEmoticon(id))) {
        return NextResponse.json({ error: '되살릴 이모티콘이 없습니다' }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }

    if (body.name !== undefined) {
      const name = normalizeName(body.name);
      if (name === '') {
        return NextResponse.json({ error: '이모티콘 이름을 입력해 주세요' }, { status: 400 });
      }
      if (!(await renameEmoticon(id, name))) {
        return NextResponse.json({ error: '이모티콘을 찾을 수 없습니다' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, name });
    }
  } catch (err) {
    if (err instanceof EmoticonNameTakenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ error: 'name 또는 restore 가 필요합니다' }, { status: 400 });
}
