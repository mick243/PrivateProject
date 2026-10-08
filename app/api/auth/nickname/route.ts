import { NextResponse } from 'next/server';
import { conflict, handle, needLogin, parseBody } from '@/lib/api-errors';
import {
  claimNickname,
  clearSessionCookie,
  getSession,
  nicknameStatus,
  setPlayerPassword,
  setSessionCookie,
} from '@/lib/auth';
import { nicknameInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 소셜로 막 들어온 사람이 **이름을 정하는** 자리 (/welcome 화면의 짝).
 *
 * 아이디/비밀번호 가입에는 이 라우트가 필요 없습니다 — 가입 화면에서 이미 본인이
 * 이름을 골랐습니다. 소셜만 그 화면이 없어서, 로그인 뒤 한 번 묻고 그 답을
 * 여기서 받습니다 (lib/auth.ts claimNickname).
 *
 * "한 번" 인 것이 중요합니다. 조건 없이 이름을 바꿔 주면 이 라우트가 곧 개명
 * 기능이 되는데, 비운 이름을 다른 사람이 곧바로 차지해 예전 글의 작성자를
 * 사칭할 수 있습니다. 그래서 nickname_pending 이 켜진 계정만 통과시킵니다.
 */

/** GET — 지금 물어볼 상태인가, 미리 채워 둘 이름은 무엇인가 */
async function onGet(request: Request) {
  const session = await getSession(request);
  if (!session) return needLogin();

  const status = await nicknameStatus(session.playerId);
  // 계정이 사라졌다면 쿠키도 같이 정리합니다 (app/api/auth/session 과 같은 처리).
  if (!status) return clearSessionCookie(needLogin());

  return NextResponse.json(status);
}

/** POST — `{nickname, password?}` → 이름 확정 (+ 선택한 경우 비밀번호 설정) + 세션 쿠키 재발급 */
async function onPost(request: Request) {
  const session = await getSession(request);
  if (!session) return needLogin();

  const body = await parseBody(request, nicknameInputSchema);
  if (!body.ok) return body.response;

  const result = await claimNickname(session.playerId, body.value.nickname);
  if (!result.ok) {
    if (result.reason === 'gone') return clearSessionCookie(needLogin());
    if (result.reason === 'settled') {
      // 뒤로 가기로 이 화면에 다시 온 경우가 대부분입니다. 실패이긴 하지만
      // 사용자가 고칠 것이 없으므로 무엇이 끝났는지만 알려 줍니다.
      return conflict('닉네임은 이미 정해졌습니다');
    }
    if (result.reason === 'reserved') return conflict('사용할 수 없는 닉네임입니다');
    // 가입과 같은 이유로 "이미 있다"를 숨기지 않습니다 — 숨기면 무엇을 고쳐야
    // 하는지 알려 줄 방법이 없고, 어차피 플레이어 목록에 이름이 그대로 보입니다.
    return conflict('이미 사용 중인 닉네임입니다');
  }

  // 비밀번호는 이름이 확정된 뒤에 겁니다 — 이름이 409 로 반려됐는데 비밀번호만
  // 먼저 박히면, 사용자는 실패로 알고 있는데 계정 상태는 바뀌어 있게 됩니다.
  if (body.value.password !== undefined) {
    await setPlayerPassword(session.playerId, body.value.password);
  }

  // 쿠키를 **반드시** 다시 발급합니다 — 위에서 비밀번호를 정했다면 그 순간
  // 계정의 세대 번호가 올라가 지금 들고 있는 쿠키가 무효가 되기 때문입니다
  // (lib/auth.ts setPlayerPassword). 이름을 정하자마자 로그아웃되면 안 됩니다.
  return setSessionCookie(NextResponse.json({ user: result.user }), result.user.playerId);
}

export const GET = handle(onGet);
export const POST = handle(onPost);
