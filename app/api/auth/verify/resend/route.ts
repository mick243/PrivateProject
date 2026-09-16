import { NextResponse } from 'next/server';
import { appOrigin } from '@/lib/app-url';
import { requirePlayer } from '@/lib/auth';
import { isMailConfigured, sendVerificationMail, verificationStatus } from '@/lib/email-verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 인증 메일 다시 보내기.
 *
 * GET — 지금 상태 `{email, verified, mailConfigured}`. 화면이 배너를 그릴지,
 *       "다시 보내기" 버튼을 열지 정하는 근거입니다.
 * POST — 한 통 더 보냅니다.
 *
 * 둘 다 **로그인이 필요합니다.** 확인 자체(`/api/auth/verify`)는 토큰이 증명이라
 * 로그인을 묻지 않지만, 여기는 다릅니다 — 아무나 남의 주소로 메일을 쏘게 하면
 * 이 라우트가 남의 메일함을 두드리는 도구가 됩니다. 주소를 요청에서 받지 않고
 * **세션 주인의 것**만 쓰는 이유도 같습니다.
 *
 * 발송 횟수 제한은 lib/email-verify.ts 가 발급 이력에서 셉니다 (분당 1회 ·
 * 시간당 5회). 프로세스 메모리가 아니라 DB 라서 재시작해도 풀리지 않습니다.
 *
 * ⚠ 여기는 가입과 달리 **발송을 기다립니다.** 사용자가 버튼을 누르고 결과를
 *   보고 있으므로, after() 로 미루면 성공했는지 알려 줄 수 없습니다. 가입
 *   (app/api/auth/signup)은 반대입니다 — 메일이 늦다고 가입이 늦어지면 안 됩니다.
 */
export async function GET(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const status = await verificationStatus(guard.playerId);
  if (!status) return NextResponse.json({ error: '계정을 찾을 수 없습니다' }, { status: 404 });

  return NextResponse.json({ ...status, mailConfigured: isMailConfigured() });
}

export async function POST(request: Request) {
  const guard = await requirePlayer(request);
  if (!guard.ok) return guard.response;

  const status = await verificationStatus(guard.playerId);
  if (!status) return NextResponse.json({ error: '계정을 찾을 수 없습니다' }, { status: 404 });
  if (!status.email) {
    // 소셜로만 가입한 계정입니다 — players.email 이 비어 있어 보낼 곳이 없습니다.
    return NextResponse.json(
      { error: '이 계정에는 등록된 이메일이 없습니다' },
      { status: 409 },
    );
  }
  if (status.verified) {
    return NextResponse.json({ error: '이미 확인된 이메일입니다' }, { status: 409 });
  }

  const issued = await sendVerificationMail(guard.playerId, appOrigin(request), {
    throttle: true,
  });

  if (!issued.ok) {
    if (issued.reason === 'too-soon') {
      const s = issued.retryAfterS ?? 60;
      return NextResponse.json(
        {
          error:
            s > 120
              ? '메일을 너무 자주 보냈습니다. 잠시 후 다시 시도해 주세요'
              : `${s}초 후에 다시 보낼 수 있습니다`,
        },
        { status: 429, headers: { 'retry-after': String(s) } },
      );
    }
    // 발송 실패(제공자 오류·키 미설정)는 사용자가 고칠 수 없습니다. 그대로
    // 말해 주고 다시 누를 수 있게 둡니다 — 성공한 척하면 오지 않는 메일을
    // 기다리게 됩니다.
    return NextResponse.json(
      { error: '메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요' },
      { status: 502 },
    );
  }

  return NextResponse.json({ sent: true, email: status.email });
}
