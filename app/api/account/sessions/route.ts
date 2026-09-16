import { NextResponse } from 'next/server';
import { getSession, revokeSessions, setSessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/account/sessions — **다른 기기에서 모두 로그아웃**.
 *
 * 세션 쿠키는 서명만으로 성립해서, 예전에는 한 번 나간 쿠키를 거둘 방법이
 * 없었습니다. 로그아웃은 내 브라우저의 쿠키를 지우는 것뿐이라 PC방에 열어 두고
 * 온 창이나 누가 복사해 간 쿠키에는 아무 영향이 없었습니다
 * (docs/QA-LAUNCH-READINESS.md H12). 이제 계정의 세대 번호를 올리면 그 순간
 * 지난 쿠키가 전부 무효가 됩니다.
 *
 * **비밀번호를 다시 묻지 않습니다.** 이 화면(/account)은 비밀번호가 있는 계정이면
 * 이미 본인 확인을 통과해야 들어오고, 소셜로만 가입한 계정은 물어볼 비밀번호가
 * 없습니다 — 정작 이 버튼이 유일한 수단인 사람들을 막게 됩니다. 그리고 이건
 * 잠그는 쪽 동작이라, 남이 눌러 봐야 그 사람도 함께 튕기고 주인은 이상한
 * 로그아웃을 보게 됩니다(알아챌 신호가 하나 느는 셈입니다).
 *
 * 누른 사람의 쿠키는 새 번호로 다시 발급합니다 — 안 그러면 "다른 기기" 가 아니라
 * "나까지 전부" 가 됩니다. 비밀번호 변경(app/api/account PUT)이 같은 모양입니다.
 */
export async function DELETE(request: Request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });

  await revokeSessions(session.playerId);
  return setSessionCookie(NextResponse.json({ user: session }), session.playerId);
}
