import { NextResponse } from 'next/server';
import { fail, handle, needLogin, notFound, parseId, readJson } from '@/lib/api-errors';
import { sessionPlayerId } from '@/lib/auth';
import { addFavorite, listFavoriteIds, removeFavorite } from '@/lib/favorites';
import { isForeignKeyViolation } from '@/lib/pg-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 즐겨찾기 — 내가 담아 둔 오락실 id 목록.
 *
 * 누구인지는 **세션에서만** 읽습니다. 쓰기 경로가 전부 그렇게 바뀌기 전까지
 * 이 라우트만 그랬고(lib/auth.ts requirePlayer 주석), 그 시절의 근거는 이랬습니다
 * — 본문의 playerId 를 믿으면 남의 즐겨찾기에 곳을 담을 수 있는데, 리뷰·제보는
 * 공개되는 값이라 티라도 나지만 즐겨찾기는 조용히 어긋납니다.
 */

/**
 * GET /api/favorites
 *
 * 비로그인은 401 이 아니라 빈 목록입니다 — 화면은 로그인 여부와 무관하게 이걸
 * 한 번 부르고(사이드바가 별을 그릴지 정하려면 필요합니다), 로그인하지 않은
 * 상태는 오류가 아니라 정상입니다.
 */
async function onGet(request: Request) {
  const playerId = await sessionPlayerId(request);
  return NextResponse.json({
    arcadeIds: playerId === null ? [] : await listFavoriteIds(playerId),
  });
}

/**
 * PUT /api/favorites — 담기 `{arcadeId}`. 이미 담아 뒀으면 그대로 성공.
 *
 * 예전에는 `POST` 였습니다. 지침서(GUIDELINES §4-1)가 상태를 바꾸는 요청을
 * `PUT`(켠다)·`DELETE`(끈다)로 하라고 정해 두었는데 그 모양인 것은 글 추천 하나뿐이라,
 * 문서를 보고 PUT 을 부르면 405 가 났습니다 (2026-09-13 전체 점검). 코드를 옮겼습니다.
 */
async function onPut(request: Request) {
  const playerId = await sessionPlayerId(request);
  if (playerId === null) return needLogin();

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const arcadeId = parseId((body.value as { arcadeId?: unknown } | null)?.arcadeId);
  if (arcadeId === null) return fail(400, 'arcadeId 가 필요합니다');

  try {
    await addFavorite(playerId, arcadeId);
  } catch (err) {
    // 없는 오락실이면 FK 위반이다. 존재 확인을 따로 하면 그 사이에 지워지는
    // 틈이 남으므로 DB 제약을 그대로 답으로 옮긴다.
    if (isForeignKeyViolation(err)) return notFound('오락실을 찾을 수 없습니다');
    throw err;
  }

  return NextResponse.json({ arcadeIds: await listFavoriteIds(playerId) });
}

/**
 * DELETE /api/favorites?arcadeId=3 — 빼기.
 *
 * 담아 두지 않았던 곳이어도 200 입니다. 별을 두 번 누른 것뿐인데 오류를 띄우면,
 * 화면에는 이미 빠져 있는 상태라 사람이 고칠 방법이 없습니다.
 */
async function onDelete(request: Request) {
  const playerId = await sessionPlayerId(request);
  if (playerId === null) return needLogin();

  const arcadeId = parseId(new URL(request.url).searchParams.get('arcadeId'));
  if (arcadeId === null) return fail(400, 'arcadeId 가 필요합니다');

  await removeFavorite(playerId, arcadeId);
  return NextResponse.json({ arcadeIds: await listFavoriteIds(playerId) });
}

export const GET = handle(onGet);
export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
