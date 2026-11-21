import { NextResponse } from 'next/server';
import { fail, handle, parseBody } from '@/lib/api-errors';
import { setSessionCookie, suspensionMessage } from '@/lib/auth';
import { consumePasswordReset, type ResetCheck } from '@/lib/password-reset';
import { resetConfirmSchema } from '@/lib/password-reset-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 링크를 쓸 수 없을 때 — 무슨 일 + 할 일 (docs/DESIGN-GUIDE.md §2-5) */
const REASON_MESSAGES: Record<Exclude<ResetCheck, 'ok'>, string> = {
  invalid: '열 수 없는 링크예요. 가장 최근에 받은 메일을 열거나 새 링크를 받아 주세요',
  expired: '링크 기한(1시간)이 지났어요. 새 링크를 받아 주세요',
  used: '이미 쓴 링크예요. 바꾼 비밀번호로 로그인해 주세요',
  changed: '메일을 보낸 뒤 이메일 주소가 바뀌었어요. 새 링크를 받아 주세요',
};

/**
 * POST /api/auth/password-reset/confirm `{token, password, passwordConfirm}`
 *
 * 링크로 새 비밀번호를 정합니다. 다른 기기의 로그인은 모두 끊기고(token_epoch + 1),
 * **이 창은 곧바로 로그인됩니다** — 방금 정한 비밀번호를 한 번 더 치게 하는 화면은 아무것도
 * 확인해 주지 않습니다(가입과 같은 판단). 링크를 가진 사람은 어차피 비밀번호를 정해 로그인할
 * 수 있으므로 더 열어 주는 것은 없습니다. 정지된 계정은 비밀번호만 바꾸고 로그인시키지 않습니다
 * (`{user: null, suspended}`).
 *
 * 링크를 쓸 수 없으면 409 + `reason`(화면이 '새 링크 받기' 를 열지 정함).
 */
async function onPost(request: Request) {
  const body = await parseBody(request, resetConfirmSchema, 'first');
  if (!body.ok) return body.response;

  const result = await consumePasswordReset(body.value.token, body.value.password);
  if (!result.ok) {
    return fail(409, REASON_MESSAGES[result.reason], { extra: { reason: result.reason } });
  }

  const suspended = await suspensionMessage(result.playerId);
  if (suspended) return NextResponse.json({ user: null, suspended });

  const user = { playerId: result.playerId, nickname: result.nickname, isAdmin: false };
  return setSessionCookie(NextResponse.json({ user }), result.playerId);
}

export const POST = handle(onPost);
