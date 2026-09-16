import { NextResponse } from 'next/server';
import { clearSessionCookie, getSession, readCookie, readSessionToken } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/session — 지금 로그인한 사람 `{user}` (없으면 `{user: null}`)
 *
 * 화면이 관리자 버튼을 그릴지 정하는 근거입니다. getSession 이 요청마다 players
 * 를 보므로(lib/auth.ts) 여기서 이름·권한을 따로 조회하지 않습니다 — 예전에는
 * 같은 줄을 두 번 읽었습니다.
 *
 * **탭이 돌아올 때마다 부르는 자리**라, 세션이 회수됐거나 계정이 사라졌으면
 * 여기서 쿠키까지 치웁니다. 안 치우면 이미 죽은 쿠키를 계속 들고 다니며 요청마다
 * DB 를 한 번씩 더 보게 됩니다.
 */
export async function GET(request: Request) {
  const session = await getSession(request);
  if (session) return NextResponse.json({ user: session });

  // 세션은 없는데 쿠키는 남아 있는 상태 — 회수됐거나 탈퇴한 계정입니다.
  const stale = readSessionToken(readCookie(request, SESSION_COOKIE)) !== null;
  const res = NextResponse.json({ user: null });
  return stale ? clearSessionCookie(res) : res;
}
