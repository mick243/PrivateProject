import { NextResponse } from 'next/server';
import { consumeVerification } from '@/lib/email-verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/verify?token=… — 인증 메일의 링크가 도착하는 자리
 *
 * 메일함에서 눌러 들어오므로 **화면으로 302** 합니다. JSON 을 돌려주면 사용자는
 * 브라우저에 중괄호를 보게 됩니다. 결과는 `?status=` 로 넘기고 문구는
 * `/verify-email` 이 만듭니다 (OAuth 콜백이 `/login?error=…` 로 돌려보내는 것과
 * 같은 방식입니다).
 *
 * **로그인을 요구하지 않습니다.** 메일은 다른 기기·다른 브라우저에서 열리는 것이
 * 보통이고, 그 링크를 여는 사람이 그 메일함의 주인이라는 것 자체가 증명입니다.
 * 로그인을 요구하면 확인하러 온 사람에게 로그인 화면을 먼저 들이밀게 됩니다.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token');

  const status = token ? await consumeVerification(token) : 'invalid';

  // 토큰을 그대로 둔 채 이동하면 주소창·히스토리·Referer 에 남습니다.
  // 이미 써 버린 1회용 값이지만, 남길 이유도 없습니다.
  return NextResponse.redirect(new URL(`/verify-email?status=${status}`, request.url));
}
