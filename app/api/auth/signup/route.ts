import { after, NextResponse } from 'next/server';
import { fail, handle, readJson, tooMany } from '@/lib/api-errors';
import { appOrigin } from '@/lib/app-url';
import {
  clearLoginFailures,
  clientKey,
  createAccount,
  loginLockRemainingMs,
  noteLoginFailure,
  RESERVED_NICKNAME_MESSAGE,
  setSessionCookie,
  signupConflictReason,
} from '@/lib/auth';
import { isEmailMaskingOn } from '@/lib/email-mask';
import { isMailConfigured, sendVerificationMail } from '@/lib/email-verify';
import { isUniqueViolation } from '@/lib/pg-errors';
import { formatIssues, issueFields, signupInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/signup — 회원가입 `{nickname, email, password, passwordConfirm}`
 *
 * 성공하면 **곧바로 로그인 상태**로 만듭니다(세션 쿠키). 방금 정한 비밀번호를
 * 다시 치게 하는 화면은 아무것도 확인해 주지 않습니다.
 *
 * 가입이 끝나면 **인증 메일을 한 통 보냅니다.** 다만 `after()` 로 미룹니다 —
 * 응답을 먼저 보내고 발송은 그 뒤에 돕니다. 메일 API 가 느리거나 죽었다고
 * 가입까지 실패하면 안 되기 때문입니다. 실패해도 계정은 남고, 사용자는
 * `/verify-email` 에서 다시 보낼 수 있습니다.
 *
 * 확인은 **관문이 아닙니다.** 확인 전에도 둘러보고 글을 씁니다. 확인이 여는
 * 것은 비밀번호 찾기입니다 (lib/password-reset.ts — 확인된 이메일로만 링크를 보냅니다).
 * 응답의 `emailVerification`('sent' | 'off')으로 가입 완료 화면이 그 안내를 한 줄로 합니다.
 *
 * 가입해서 얻는 건 "이 닉네임은 내 것" 뿐이고, 관리자 권한은 여기로 오지 않습니다
 * (lib/auth.ts createAccount 는 is_admin 을 건드리지 않습니다).
 *
 * 시도 제한은 로그인과 같은 통을 쓰되 키를 나눕니다 — 가입 실패로 로그인이
 * 잠기면 이미 계정이 있는 사람이 남의 시도 때문에 못 들어옵니다.
 *
 * 400 · 409 에는 **어느 칸이 문제인지**(`field`)를 함께 줍니다. 가입 화면은 한 단계에
 * 한 칸만 묻기 때문에(docs/DESIGN-GUIDE.md §1-2), 문구만으로는 사용자를 어느 단계로
 * 돌려보낼지 알 수 없습니다. 값은 입력 스키마의 키 이름(`nickname` · `email` · …)입니다.
 */
async function onPost(request: Request) {
  /**
   * 가입 제한은 IP 밖에 근거가 없습니다 — 아직 계정이 없으니 계정 단위로 셀 수가
   * 없습니다. 그래서 **클라이언트를 신뢰할 수 있을 때만** 셉니다
   * (`TRUSTED_PROXY_HOPS`, lib/auth.ts clientKey).
   *
   * ⚠ **프록시가 없으면 가입 제한이 없습니다.** 예전 구현은 위조 가능한 헤더로
   * 세고 있었으니 그때도 실효는 없었고, 지금은 그 사실이 드러나 있을 뿐입니다.
   * 대량 가입을 막아야 하면 앞에 프록시를 두고 `TRUSTED_PROXY_HOPS` 를 주세요.
   * (`npm run start:cluster` 는 자동으로 1 을 넣습니다.)
   *
   * null 을 문자열로 만들어 한 바구니에 몰지 않는 것이 중요합니다 —
   * `signup:null` 로 세면 8번 실패에 **전원 가입이 잠깁니다.**
   */
  const ip = clientKey(request);
  const key = ip === null ? null : `signup:${ip}`;
  const lockedFor = key === null ? 0 : await loginLockRemainingMs(key);
  if (lockedFor > 0) {
    return tooMany(`가입 시도가 많아 잠깐 막았어요. ${Math.ceil(lockedFor / 60000)}분 뒤에 다시 시도해 주세요`, lockedFor);
  }

  const raw = await readJson(request);
  if (!raw.ok) return raw.response;
  const parsed = signupInputSchema.safeParse(raw.value);
  if (!parsed.success) {
    const details = formatIssues(parsed.error);
    // 한 칸짜리 화면이라 첫 문구를 그대로 error 로 줍니다 — "다시 확인해 주세요" 만으로는 무엇을 고칠지 모릅니다.
    return fail(400, details[0] ?? '입력한 내용을 다시 확인해 주세요', {
      details,
      extra: { field: issueFields(parsed.error)[0] ?? null },
    });
  }

  try {
    const result = await createAccount(parsed.data.nickname, parsed.data.password, parsed.data.email);
    if (!result.ok) {
      // 로그인과 달리 "이미 있는 아이디" 를 숨기지 않습니다. 숨기면 가입이
      // 불가능해집니다 — 무엇을 고쳐야 하는지 알려 줄 방법이 없습니다.
      // 어차피 플레이어 목록에 닉네임이 그대로 보입니다.
      if (key !== null) await noteLoginFailure(key);
      return conflictResponse(result.reason);
    }

    if (key !== null) await clearLoginFailures(key);

    // 응답을 먼저 보내고 나서 보냅니다 (위 주석). 여기서 던져도 가입은
    // 이미 끝났으므로, 실패는 sendVerificationMail 안에서 로그로만 남습니다.
    const origin = appOrigin(request);
    const newPlayerId = result.user.playerId;
    after(async () => {
      await sendVerificationMail(newPlayerId, origin);
    });

    // 가입 완료 화면이 "확인 메일을 보냈어요" 라고 말해도 되는지 (UX 시험 A-2).
    // 이메일을 가리는 기간이거나 운영에 메일 키가 없으면 보내지 않으므로 'off' — 보내지 않은
    // 메일을 기다리게 하지 않습니다. 발송 자체의 성패는 after() 뒤라 여기서 알 수 없습니다.
    const emailVerification =
      isEmailMaskingOn() || (process.env.NODE_ENV === 'production' && !isMailConfigured()) ? 'off' : 'sent';

    return setSessionCookie(
      NextResponse.json({ user: result.user, emailVerification }, { status: 201 }),
      result.user.playerId,
    );
  } catch (err) {
    // 같은 순간에 같은 아이디·같은 주소로 두 명이 가입한 경우 (createAccount 의
    // 선검사와 INSERT 사이). 500 이 아니라 위와 같은 안내로 돌려줍니다.
    if (isUniqueViolation(err)) {
      return conflictResponse(signupConflictReason(err));
    }
    throw err;
  }
}

export const POST = handle(onPost);

/**
 * 겹쳤을 때 뭐라고 할 것인가.
 *
 * 로그인과 달리 "이미 있다" 를 숨기지 않습니다. 숨기면 가입이 불가능해집니다 —
 * 무엇을 고쳐야 하는지 알려 줄 방법이 없기 때문입니다. 닉네임은 어차피 플레이어
 * 목록에 그대로 보입니다.
 *
 * 이메일은 사정이 다릅니다. 여기서 "이미 가입된 주소" 라고 답하면 **그 주소로
 * 계정이 있는지** 를 아무나 확인할 수 있게 됩니다. 그래도 알려 주는 쪽을 택한
 * 이유는, 가입 화면에서 막힌 사람에게 다음에 뭘 할지(로그인 또는 비밀번호 찾기)
 * 말해 주지 않으면 그 사람은 영영 못 들어오기 때문입니다. 이 교환이 불편해지면
 * — 즉 이메일이 확인된 주소가 되면 — 그때는 "가입 안내 메일을 보냈습니다" 로
 * 바꾸는 것이 정석입니다. 답은 화면이 아니라 메일함에만 있게 됩니다.
 */
function conflictMessage(reason: 'taken' | 'reserved' | 'email-taken'): string {
  if (reason === 'email-taken') {
    return '이미 가입한 이메일이에요. 그 계정으로 로그인해 주세요';
  }
  // 예약어를 "이미 사용 중" 이라고 하면 숫자만 바꿔 다시 시도하게 됩니다 — 그래도 막힙니다.
  return reason === 'reserved'
    ? RESERVED_NICKNAME_MESSAGE
    : '이미 누가 쓰고 있는 아이디예요. 다른 아이디를 골라 주세요';
}

/** 겹친 값이 어느 칸인가 — 가입 화면이 그 단계로 돌아갑니다 */
function conflictField(reason: 'taken' | 'reserved' | 'email-taken'): 'nickname' | 'email' {
  return reason === 'email-taken' ? 'email' : 'nickname';
}

/** 409 + 문구 + 돌아갈 칸(`field`) */
function conflictResponse(reason: 'taken' | 'reserved' | 'email-taken') {
  return fail(409, conflictMessage(reason), { extra: { field: conflictField(reason) } });
}
