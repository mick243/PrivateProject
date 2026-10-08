import { NextResponse } from 'next/server';
import { conflict, fail, handle } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { EMOTICON_EXTS, EMOTICON_MAX_BYTES } from '@/lib/community-types';
import {
  createEmoticon,
  EmoticonNameTakenError,
  listEmoticons,
  normalizeName,
} from '@/lib/emoticons';
import { detect, save } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOO_LARGE = `이모티콘은 ${Math.round(EMOTICON_MAX_BYTES / 1024 / 1024)}MB 까지 올릴 수 있습니다`;
const UNSUPPORTED = 'JPG · PNG · GIF 만 올릴 수 있습니다';

/**
 * GET /api/emoticons — 고를 수 있는 이모티콘 전부.
 *
 * 로그인을 요구하지 않습니다. 비로그인도 댓글에 박힌 이모티콘을 **보아야** 하고,
 * 그러려면 id → 이름 표가 필요합니다 (components/EmoticonText.tsx).
 */
async function onGet() {
  return NextResponse.json({ emoticons: await listEmoticons() });
}

/**
 * POST /api/emoticons — 이모티콘 등록 (multipart: `file`, `name`). **관리자만.**
 *
 * 목록이 공용이라 한 장이 모든 화면에 뜹니다. 누구나 올릴 수 있으면 올라온 그림을
 * 사람이 보기 전에는 무엇인지 알 수 없고, 저장 공간도 사용자 수만큼 늘어납니다.
 *
 * 형식은 클라이언트가 말하는 Content-Type 이 아니라 매직 바이트로 봅니다
 * (lib/uploads.ts detect) — .jpg 로 이름만 바꾼 파일을 막는 가장 싼 방법입니다.
 * webp·mp4 는 save() 가 받는 형식이지만 여기서는 **받지 않습니다**: 요청이
 * jpg·png·gif 였고, 목록에 없는 형식이 조용히 섞이면 나중에 무엇이 들어 있는지
 * 아무도 모릅니다.
 */
async function onPost(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  // 본문을 메모리로 올리기 전에 신고된 길이부터 거릅니다 (app/api/uploads 와 같은 이유).
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > EMOTICON_MAX_BYTES + 1024 * 1024) return fail(413, TOO_LARGE);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, '업로드 본문을 읽을 수 없습니다');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return fail(400, 'file 이 필요합니다');
  if (file.size > EMOTICON_MAX_BYTES) return fail(413, TOO_LARGE);

  const name = normalizeName(form.get('name'));
  if (name === '') return fail(400, '이모티콘 이름을 입력해 주세요');

  const buffer = Buffer.from(await file.arrayBuffer());
  const kind = detect(buffer);
  if (!kind || !(EMOTICON_EXTS as readonly string[]).includes(kind.ext)) return fail(415, UNSUPPORTED);
  // 신고된 크기와 실제 크기가 다를 수 있으므로 버퍼로도 한 번 더 봅니다.
  if (buffer.byteLength > EMOTICON_MAX_BYTES) return fail(413, TOO_LARGE);

  try {
    const saved = await save(buffer);
    const emoticon = await createEmoticon({ ...saved, name, playerId: guard.user.playerId });
    return NextResponse.json({ emoticon }, { status: 201 });
  } catch (err) {
    if (err instanceof EmoticonNameTakenError) return conflict(err.message);
    throw err;
  }
}

export const GET = handle(onGet);
export const POST = handle(onPost);
