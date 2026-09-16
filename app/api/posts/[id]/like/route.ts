import { NextResponse } from 'next/server';
import { requirePlayer } from '@/lib/auth';
import { getPost, setLike } from '@/lib/board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 추천 — `PUT` 으로 켜고 `DELETE` 로 끕니다. 둘 다 **여러 번 불러도 같습니다.**
 *
 * ─── 예전 판단을 뒤집습니다 ──────────────────────────────────
 * 여기에는 `POST` 하나가 상태를 뒤집는 토글이 있었고, 주석에 이유가 적혀 있었습니다 —
 * *"켜고 끄는 두 엔드포인트로 나누지 않는 이유: 클라이언트가 현재 상태를 알고
 * 있어야 하고, 그 상태가 틀리면(다른 탭에서 이미 눌렀다면) 조용히 어긋납니다."*
 *
 * 걱정 자체는 맞습니다. 다만 **토글이 그 문제에 더 취약합니다.**
 *
 *   두 탭이 모두 "추천 안 함" 으로 보고 있다 → 둘 다 누른다
 *     토글:      켜짐 → 꺼짐.  누른 사람의 뜻과 반대로 끝납니다
 *     PUT:       켜짐 → 켜짐.  "추천하고 싶다" 가 두 번 이뤄집니다
 *
 * 그리고 토글은 **재시도에 깨집니다.** 모바일에서 응답을 못 받고 재전송하거나
 * 버튼을 두 번 탭하면 두 번 뒤집혀 원래대로 돌아갑니다. 그 수가 인기글 정렬의
 * 근거라 조용히 틀린 순위가 됩니다.
 *
 * 멱등한 쪽은 "지금 상태" 를 몰라도 됩니다 — 하려는 일만 말하면 됩니다.
 *
 * ─── 누가 눌렀는가 ─────────────────────────────────────────
 * 세션 쿠키가 정합니다. 본문의 `playerId` 를 믿던 동안에는 번호 하나만 바꿔
 * 남의 이름으로 추천을 켜고 끌 수 있었고, 그 수가 인기글 정렬의 근거입니다.
 *
 * ─── commentOffset ──────────────────────────────────────────
 * 보고 있던 댓글 페이지를 유지합니다. 추천을 눌렀다고 댓글이 1페이지로 돌아가면
 * 안 됩니다. `PUT` 은 본문으로, `DELETE` 는 쿼리스트링으로 받습니다 (DELETE 에
 * 본문을 싣는 것은 중간 장비가 버리는 경우가 있어 피합니다).
 */
/** 양의 정수만. 아니면 0 = 댓글 1페이지 */
function offsetOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * `PUT` 의 본문은 **없어도 됩니다.** 예전에는 필수였는데 그건 거기에 `playerId` 가
 * 실려 있었기 때문입니다. 누구인지를 쿠키가 말하게 된 뒤로 본문에 남은 것은
 * 화면 복원용 곁가지 하나뿐이라, 그것 때문에 추천이 400 으로 실패하면 안 됩니다.
 */
async function offsetFromBody(request: Request): Promise<number> {
  try {
    const body = (await request.json()) as { commentOffset?: unknown } | null;
    return offsetOf(body?.commentOffset);
  } catch {
    return 0;
  }
}

async function apply(request: Request, ctx: Ctx, liked: boolean): Promise<NextResponse> {
  const postId = parseId((await ctx.params).id);
  if (postId === null) {
    return NextResponse.json({ error: '잘못된 id 입니다' }, { status: 400 });
  }

  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;
  const { playerId } = guard;

  const commentOffset = liked
    ? await offsetFromBody(request)
    : offsetOf(new URL(request.url).searchParams.get('commentOffset'));

  if (!(await getPost(postId, null))) {
    return NextResponse.json({ error: '글을 찾을 수 없습니다' }, { status: 404 });
  }

  const result = await setLike(postId, playerId, liked);
  return NextResponse.json({
    ...result,
    post: await getPost(postId, playerId, commentOffset),
  });
}

/** PUT /api/posts/:id/like — 추천을 켭니다 (본문 `{commentOffset?}` 은 생략 가능) */
export const PUT = (request: Request, ctx: Ctx) => apply(request, ctx, true);

/** DELETE /api/posts/:id/like?commentOffset=10 — 추천을 끕니다 */
export const DELETE = (request: Request, ctx: Ctx) => apply(request, ctx, false);
