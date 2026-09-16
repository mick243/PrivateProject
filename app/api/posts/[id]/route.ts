import { NextResponse } from 'next/server';
import { json } from '@/lib/http';
import { badId, badJson, handle, invalid, notFound, parseId } from '@/lib/api-errors';
import { isAdminRequest, requirePlayer, sessionPlayerId } from '@/lib/auth';
import { deletePost, deletePostAsAdmin, getPost, updatePost } from '@/lib/board';
import { isForeignKeyViolation } from '@/lib/pg-errors';
import { postInputSchema } from '@/lib/validation';
import { noticeGuard } from '../notice-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () => notFound('글을 찾을 수 없습니다');
/** 남의 글을 고치거나 지우려는 경우. 존재 여부는 알려주되 권한은 막는다. */
const NOT_MINE = () =>
  NextResponse.json({ error: '본인이 쓴 글만 수정·삭제할 수 있습니다' }, { status: 403 });

/**
 * GET /api/posts/:id?view=1&commentOffset=10
 *   내 추천 여부는 세션 주인 기준입니다 (`?playerId=` 는 더 받지 않습니다).
 *   view=1 이면 조회수를 올립니다. 목록에서 상세를 열 때만 붙이고,
 *   수정·삭제·추천 후 다시 읽을 때는 붙이지 않습니다.
 *   commentOffset 은 댓글 페이지의 시작 위치입니다. 범위를 벗어나면 마지막
 *   페이지로 당겨지고, 실제로 쓰인 값이 post.commentOffset 으로 나갑니다.
 */
async function onGet(request: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const { searchParams } = new URL(request.url);
  const playerId = await sessionPlayerId(request);

  const rawOffset = Number(searchParams.get('commentOffset'));
  const commentOffset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  // 조회수 +1 도 상세 쿼리 안에서 같이 처리한다 — 예전에는 UPDATE 를 먼저
  // 보내고 기다렸다(왕복 하나 = 풀 슬롯 하나, PERFORMANCE.md 2부).
  const post = await getPost(id, playerId, commentOffset, searchParams.get('view') === '1');
  return post ? json(request, { post }) : NOT_FOUND();
}

/** PUT /api/posts/:id — 본인 글 수정 (로그인 필요) */
async function onPut(request: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badJson();
  }

  const parsed = postInputSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error);
  }

  const existing = await getPost(id, null);
  if (!existing) return NOT_FOUND();

  // 일반 글로 올린 뒤 말머리만 공지로 바꾸는 길도 같이 막는다 (../notice-guard.ts)
  const denied = await noticeGuard(request, parsed.data);
  if (denied) return denied;

  try {
    const updated = await updatePost(id, guard.playerId, {
      ...parsed.data,
      playerId: guard.playerId,
    });
    if (!updated) return NOT_MINE();
    return NextResponse.json({ post: await getPost(id, guard.playerId) });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return NextResponse.json(
        { error: '말머리 또는 게임을 다시 확인해 주세요' },
        { status: 400 },
      );
    }
    throw err;
  }
}

/**
 * DELETE /api/posts/:id — 글 삭제 (본인 또는 **관리자**)
 *
 * 누구인지는 둘 다 세션 쿠키가 정합니다. 예전에는 일반 사용자만 `?playerId=` 로
 * 받았는데, 그러면 번호를 아는 사람이 남의 글을 지울 수 있었습니다 — 관리자
 * 경로는 처음부터 쿠키를 봤으니 일반 경로만 뚫려 있던 셈입니다.
 *
 * 수정(PUT)은 열지 않았습니다. 지우는 것과 달리 고치는 건 남의 이름으로 남는
 * 글의 내용이 바뀌는 일이라, 관리에 필요한 최소한을 넘습니다.
 */
async function onDelete(request: Request, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (id === null) return badId();

  const existing = await getPost(id, null);
  if (!existing) return NOT_FOUND();

  if (await isAdminRequest(request)) {
    await deletePostAsAdmin(id);
    return new NextResponse(null, { status: 204 });
  }

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const deleted = await deletePost(id, guard.playerId);
  return deleted ? new NextResponse(null, { status: 204 }) : NOT_MINE();
}

/**
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
export const PUT = handle(onPut);
export const DELETE = handle(onDelete);
