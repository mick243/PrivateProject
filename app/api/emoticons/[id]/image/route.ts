import { NextResponse } from 'next/server';
import { getEmoticonFile } from '@/lib/emoticons';
import { readRange, size } from '@/lib/uploads';

export const runtime = 'nodejs';

/**
 * GET /api/emoticons/:id/image — 이모티콘 그림.
 *
 * 첨부와 같은 이유로 `public/` 이 아니라 라우트로 나갑니다 (lib/uploads.ts 머리말).
 * 로그인을 요구하지 않습니다 — 댓글에 박힌 그림은 비로그인에게도 보여야 합니다.
 *
 * 구간 요청(Range)은 다루지 않습니다. 첨부 라우트가 그것을 지원하는 이유는
 * 동영상 탐색 때문인데(app/api/uploads/[id]), 이모티콘은 몇십 KB 짜리 그림
 * 하나라 한 번에 보내는 것이 언제나 낫습니다.
 *
 * 파일명이 내용 해시이고 id 는 재사용되지 않으므로(SERIAL) 영구 캐시입니다.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const file = await getEmoticonFile(id);
  if (!file) {
    return NextResponse.json({ error: '이모티콘을 찾을 수 없습니다' }, { status: 404 });
  }

  // 행은 있는데 파일이 사라진 경우 — 500 이 아니라 404 가 맞습니다.
  const total = await size(file.storageKey);
  if (total === null) {
    return NextResponse.json({ error: '이모티콘 파일이 없습니다' }, { status: 404 });
  }

  return new NextResponse(readRange(file.storageKey), {
    status: 200,
    headers: {
      'Content-Type': file.mime,
      'Content-Length': String(total),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
