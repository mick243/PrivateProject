import { after, NextResponse } from 'next/server';
import { handle, parseBody, tooMany, unavailable } from '@/lib/api-errors';
import { appOrigin } from '@/lib/app-url';
import { clientKey, takeLoginAttempt } from '@/lib/auth';
import { CONTACT_EMAIL, LEGAL_PLACEHOLDERS_PRESENT } from '@/lib/legal';
import {
  isPasswordResetAvailable,
  normalizeIdentifier,
  requestPasswordReset,
} from '@/lib/password-reset';
import { resetRequestSchema } from '@/lib/password-reset-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 비밀번호 찾기 — 링크 메일 요청 (/forgot-password 화면이 부릅니다)
 *
 * GET  — `{available, contactEmail}`. 지금 메일로 찾을 수 있는지(메일 설정 · 이메일 가림,
 *        lib/password-reset.ts isPasswordResetAvailable). 안 되면 화면이 칸 대신 문의 주소를 보여 줍니다.
 * POST — `{identifier}` (아이디나 이메일) → 늘 `{ok: true}`.
 *
 * **계정이 있든 없든 같은 답입니다.** "그런 계정이 없어요" 라고 답하면 이 라우트가 아이디 ·
 * 이메일이 가입돼 있는지 캐 보는 도구가 됩니다. 찾기 · 발송은 응답을 보낸 뒤 `after()` 로
 * 돌려 걸린 시간으로도 갈리지 않게 합니다. 확인된 이메일이 없는 계정에는 아무 일도 일어나지
 * 않습니다 — 화면이 그 사실을 함께 안내합니다.
 *
 * 시도 제한: 적어 낸 값(정규화한 아이디·이메일)마다, 그리고 믿을 수 있는 클라이언트 주소가
 * 있으면 주소마다 셉니다(GUIDELINES §5 — X-Forwarded-For 를 그대로 믿지 않음). 한 계정에
 * 가는 메일은 lib/password-reset.ts 가 발급 이력으로 따로 막습니다(분당 1통 · 시간당 5통).
 */
async function onGet() {
  return NextResponse.json({
    available: isPasswordResetAvailable(),
    contactEmail: LEGAL_PLACEHOLDERS_PRESENT ? null : CONTACT_EMAIL,
  });
}

async function onPost(request: Request) {
  const body = await parseBody(request, resetRequestSchema, 'first');
  if (!body.ok) return body.response;

  if (!isPasswordResetAvailable()) {
    // 계정과 무관한 서버 사정이라 알려 줘도 아무것도 새지 않습니다.
    return unavailable('지금은 메일로 비밀번호를 찾을 수 없어요. 조금 뒤에 다시 시도해 주세요');
  }

  const ip = clientKey(request);
  const keys = [`reset:${normalizeIdentifier(body.value.identifier)}`, ip === null ? null : `reset-ip:${ip}`].filter(
    (k): k is string => k !== null,
  );
  const lockedFor = Math.max(0, ...(await Promise.all(keys.map((k) => takeLoginAttempt(k)))));
  if (lockedFor > 0) {
    return tooMany(
      `여러 번 요청해서 잠깐 막았어요. ${Math.ceil(lockedFor / 60000)}분 뒤에 다시 시도해 주세요`,
      lockedFor,
    );
  }

  const identifier = body.value.identifier;
  const origin = appOrigin(request);
  after(async () => {
    try {
      const outcome = await requestPasswordReset(identifier, origin);
      // 누구에게 보냈는지(주소 · 아이디)는 남기지 않습니다 — 결과 종류만.
      if (outcome === 'send-failed') console.error('[password-reset] 메일을 보내지 못했습니다');
    } catch (err) {
      console.error('[password-reset] 요청 처리 실패 —', err instanceof Error ? err.message : err);
    }
  });

  return NextResponse.json({ ok: true });
}

export const GET = handle(onGet);
export const POST = handle(onPost);
