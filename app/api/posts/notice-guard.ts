import type { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { isNotice } from '@/lib/board-types';

/**
 * 공지 말머리는 관리자만.
 *
 * 글쓰기(POST)와 수정(PUT) 두 곳이 같은 판정을 봐야 해서 여기 모았습니다 —
 * 한쪽만 막으면 "일반 글로 올린 뒤 말머리만 공지로 고치는" 길이 남습니다.
 *
 * 근거는 **세션 쿠키**입니다. 화면에서 공지 칩을 감추는 것은 표시일 뿐입니다
 * (PostForm) — 이 목록을 우회해 요청해도 여기서 막힙니다.
 *
 * "남의 이름으로 공지를 올리는" 경우를 따로 보지 않습니다. 작성자가 세션
 * 주인으로 정해지므로(app/api/posts) 둘이 달라질 수가 없습니다 — 예전에는
 * 본문의 playerId 가 작성자였기 때문에 그 대조가 필요했습니다.
 *
 * @returns 막아야 하면 그 응답, 통과면 null
 */
export async function noticeGuard(
  request: Request,
  input: { category: string },
): Promise<NextResponse | null> {
  if (!isNotice(input.category)) return null;

  const guard = await requireAdmin(request);
  return guard.ok ? null : guard.response;
}
