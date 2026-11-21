import { NextResponse } from 'next/server';
import { handle, parseBody } from '@/lib/api-errors';
import { checkPasswordReset } from '@/lib/password-reset';
import { resetCheckSchema } from '@/lib/password-reset-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password-reset/check `{token}` → `{status}`
 *
 * 링크를 열자마자 쓸 수 있는지 봅니다 — 새 비밀번호를 다 적은 뒤에야 "기한이 지났어요" 를
 * 듣지 않게. 아무것도 바꾸지 않습니다. status: ok · invalid · expired · used · changed
 * (lib/password-reset.ts ResetCheck). 문구는 화면(/reset-password)이 만듭니다.
 *
 * 토큰을 GET 쿼리로 받지 않는 이유: 서버 · 프록시 접근 로그에 주소째 남습니다.
 */
async function onPost(request: Request) {
  const body = await parseBody(request, resetCheckSchema, 'first');
  if (!body.ok) return body.response;
  return NextResponse.json({ status: await checkPasswordReset(body.value.token) });
}

export const POST = handle(onPost);
