import { NextResponse } from 'next/server';
import {
  authenticate,
  clearLoginFailures,
  accountKey,
  clientKey,
  configuredAdminPassword,
  ensureAdminAccount,
  loginLockRemainingMs,
  noteLoginFailure,
  setSessionCookie,
} from '@/lib/auth';
import { formatIssues, loginInputSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/login — 관리자 로그인 `{nickname, password}`
 *
 * 성공하면 서명된 세션 쿠키를 심고 `{user}` 를 돌려줍니다.
 * 실패 이유는 한 문장으로 통일합니다 — "그런 계정 없음"과 "비밀번호 틀림"을
 * 나누면 닉네임이 존재하는지가 밖에서 확인됩니다.
 */
export async function POST(request: Request) {

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON 본문을 파싱할 수 없습니다' }, { status: 400 });
  }

  const parsed = loginInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: '입력값이 올바르지 않습니다', details: formatIssues(parsed.error) },
      { status: 400 },
    );
  }

  /**
   * 시도 제한은 **계정 단위가 주**입니다.
   *
   * 예전에는 `X-Forwarded-For` 첫 홉을 키로 썼는데, 그 헤더는 클라이언트가
   * 마음대로 보낼 수 있어서 **헤더만 바꾸면 잠금이 풀렸습니다** — 제한이
   * 사실상 없던 것과 같습니다. 표적(계정)은 위조할 수 없으므로 그쪽으로 셉니다.
   *
   * IP 는 **신뢰하는 프록시가 있을 때만** 함께 셉니다(`TRUSTED_PROXY_HOPS`).
   * 여러 계정을 훑는 공격은 계정 키로는 안 걸리기 때문입니다.
   */
  const keys = [accountKey(parsed.data.nickname), clientKey(request)].filter(
    (k): k is string => k !== null,
  );
  // 이제 DB 를 보므로 await 합니다. 키가 둘이라 병렬로 — 순서가 없습니다.
  const lockedFor = Math.max(0, ...(await Promise.all(keys.map(loginLockRemainingMs))));
  if (lockedFor > 0) {
    return NextResponse.json(
      { error: `로그인 시도가 많습니다. ${Math.ceil(lockedFor / 60000)}분 후 다시 시도해 주세요` },
      { status: 429 },
    );
  }

  if (!configuredAdminPassword()) {
    return NextResponse.json(
      { error: 'ADMIN_PASSWORD 가 설정되지 않아 로그인할 수 없습니다' },
      { status: 503 },
    );
  }

  // env 의 관리자 계정을 DB 에 맞춰 둡니다. 첫 로그인이면 여기서 계정이 생기고,
  // .env 의 비밀번호를 바꿨다면 여기서 해시가 갱신됩니다 (lib/auth.ts).
  await ensureAdminAccount();

  const user = await authenticate(parsed.data.nickname, parsed.data.password);
  if (!user) {
    await Promise.all(keys.map(noteLoginFailure));
    return NextResponse.json(
      { error: '아이디 또는 비밀번호가 올바르지 않습니다' },
      { status: 401 },
    );
  }

  await Promise.all(keys.map(clearLoginFailures));
  return setSessionCookie(NextResponse.json({ user }), user.playerId);
}
