import { NextResponse } from 'next/server';
import { json } from '@/lib/http';
import { requirePlayer, sessionPlayerId } from '@/lib/auth';
import { badJson, handle, invalid } from '@/lib/api-errors';
import { createPost, getPost, listPosts } from '@/lib/board';
import { isForeignKeyViolation } from '@/lib/pg-errors';
import { parsePostQuery, postInputSchema } from '@/lib/validation';
import { noticeGuard } from './notice-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/posts — 글 목록
 *   ?machineId=1     게임 탭 (없으면 '전체')
 *   &category=guide  말머리
 *   &sort=recent|popular   (popular 은 추천 5개 이상인 글만 — POPULAR_MIN_LIKES)
 *   &q=발판          제목·본문 부분 일치 (게시판 검색창)
 *   &limit=20&offset=20
 *
 * 내 추천 여부 표시는 세션 주인 기준입니다 — 예전에는 `?playerId=` 로 받았는데,
 * 그건 번호만 바꿔 남이 무엇을 추천했는지 훑을 수 있는 길이었습니다.
 *
 * 응답의 `notices` 는 게임 탭·말머리·정렬과 무관하게 목록 맨 위에 고정되는
 * 공지입니다 (`posts` 와 겹치지 않습니다 — lib/board.ts listPosts 주석 참고).
 */
async function onGet(request: Request) {
  const { searchParams } = new URL(request.url);
  const result = await listPosts({
    ...parsePostQuery(searchParams),
    playerId: await sessionPlayerId(request),
  });
  return json(request, result);
}

/** POST /api/posts — 글 작성 (로그인 필요) */
async function onPost(request: Request) {
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

  // 공지 말머리는 관리자만 (세션 쿠키로 판정 — ./notice-guard.ts)
  const denied = await noticeGuard(request, parsed.data);
  if (denied) return denied;

  try {
    const id = await createPost({ ...parsed.data, playerId: guard.playerId });
    const post = await getPost(id, guard.playerId);
    return NextResponse.json({ post }, { status: 201 });
  } catch (err) {
    // 없는 말머리(board_categories FK) 나 없는 기종/플레이어. 값 검증은 DB 가
    // 하고 있으므로, 위반을 500 이 아니라 400 으로 바꿔 준다.
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
 * 핸들러에서 빠져나온 예외를 JSON 500 으로 바꿉니다 (lib/api-errors.ts handle).
 * 감싸지 않으면 본문 없는 500 이 나가고, 클라이언트의 `res.json()` 이 거기서 던집니다.
 */
export const GET = handle(onGet);
export const POST = handle(onPost);
