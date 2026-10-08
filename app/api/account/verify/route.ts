import { NextResponse } from 'next/server';
import { forbidden, handle, needLogin, parseBody, tooMany } from '@/lib/api-errors';
import {
  clearLoginFailures,
  getSession,
  loginLockRemainingMs,
  noteLoginFailure,
  verifyPlayerPassword,
} from '@/lib/auth';
import { accountVerifySchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 개인정보 수정 화면의 **입장 검증** — 비밀번호가 맞는지만 답합니다.
 *
 * 통과해도 서버는 아무것도 열어 두지 않습니다. 실제 변경(PUT /api/account)이
 * 같은 비밀번호를 다시 받아 재확인합니다 — 여기서 "확인됨" 상태를 세션에 담으면
 * 그 상태가 곧 두 번째 세션이 되어 만료·회수를 따로 관리해야 합니다.
 * 시도 제한 키는 PUT 과 같습니다 — 이 라우트로 우회 대입하는 것을 막습니다.
 */
async function onPost(request: Request) {
  const session = await getSession(request);
  if (!session) return needLogin();

  // /account 화면은 error 한 줄만 띄웁니다 — 첫 문구를 머리로 (lib/api-errors.ts).
  const body = await parseBody(request, accountVerifySchema, 'first');
  if (!body.ok) return body.response;

  const key = `account:${session.playerId}`;
  const lockedMs = await loginLockRemainingMs(key);
  if (lockedMs > 0) {
    return tooMany(`시도가 너무 많습니다. ${Math.ceil(lockedMs / 60000)}분 뒤에 다시 해 주세요`, lockedMs);
  }

  if (!(await verifyPlayerPassword(session.playerId, body.value.password))) {
    await noteLoginFailure(key);
    return forbidden('비밀번호가 올바르지 않습니다');
  }

  await clearLoginFailures(key);
  return NextResponse.json({ ok: true });
}

export const POST = handle(onPost);
