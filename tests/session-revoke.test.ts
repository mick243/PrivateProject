import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth-types';

/**
 * 세션 회수 — **나간 쿠키를 거둘 수 있는가**.
 *
 * 세션은 저장소 없이 서명 한 장으로 성립합니다(lib/auth.ts sealPayload). 그래서
 * 예전에는 서버가 세션을 끊을 방법이 없었습니다 — 비밀번호를 바꿔도, 계정을
 * 지워도, 이미 나간 쿠키는 7일을 살았습니다 (docs/QA-LAUNCH-READINESS.md H12).
 *
 * 이제 계정마다 **세대 번호**(players.token_epoch)가 있고 토큰이 발급 당시의
 * 번호를 함께 지고 다닙니다. 이 파일이 보는 것은 그 번호가 실제로 문을 닫는가입니다.
 *   1. 번호를 올리면 지난 쿠키가 통하지 않는가
 *   2. 비밀번호 변경이 그 일을 **자동으로** 하는가
 *   3. 계정이 사라지면 즉시 끊기는가
 *   4. 끊은 사람 본인은 새 쿠키로 이어지는가
 *
 * DB 는 players 한 줄짜리 대역입니다 — 확인하려는 것은 SQL 이 아니라 판정입니다.
 */

type Row = { nickname: string; is_admin: boolean; token_epoch: number };

const players = new Map<number, Row>();

/**
 * Prisma 대역 — 이 파일이 쓰는 두 모양만 알아봅니다.
 *   players.findUnique   세션 판정이 읽는 한 줄 (lib/auth.ts playerRow)
 *   players.updateMany   회수·비밀번호 변경이 세대 번호를 올리는 자리 (`token_epoch: { increment }`)
 */
vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    players: {
      findUnique: async ({ where }: { where: { id: number } }) => {
        const row = players.get(where.id);
        return row ? { ...row } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: { token_epoch?: { increment: number } };
      }) => {
        const row = players.get(where.id);
        if (row && data.token_epoch?.increment) row.token_epoch += data.token_epoch.increment;
        return { count: row ? 1 : 0 };
      },
    },
  }),
}));

const {
  createSessionToken,
  getSession,
  requireAdmin,
  requirePlayer,
  revokeSessions,
  setPlayerPassword,
  setSessionCookie,
} = await import('@/lib/auth');

const PID = 42;

const request = (token: string | null) =>
  new Request('http://localhost/api/anything', {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });

/** 지금 세대로 발급받은 쿠키 — 로그인 직후의 상태 */
const freshToken = async (): Promise<string> => {
  const res = await setSessionCookie(NextResponse.json({}), PID);
  const value = res.cookies.get(SESSION_COOKIE)?.value;
  expect(value).toBeTruthy();
  return value as string;
};

beforeEach(() => {
  players.clear();
  players.set(PID, { nickname: '테스터', is_admin: false, token_epoch: 0 });
});

describe('발급', () => {
  it('setSessionCookie 는 지금 세대로 봉한다', async () => {
    players.get(PID)!.token_epoch = 7;
    const session = await getSession(request(await freshToken()));
    expect(session).toEqual({ playerId: PID, nickname: '테스터', isAdmin: false });
  });

  it('이름과 권한은 쿠키가 아니라 DB 에서 읽는다 — 쿠키에는 박혀 있지 않다', async () => {
    const token = await freshToken();
    players.get(PID)!.nickname = '바뀐이름';
    players.get(PID)!.is_admin = true;

    const session = await getSession(request(token));
    expect(session).toEqual({ playerId: PID, nickname: '바뀐이름', isAdmin: true });
  });
});

describe('회수', () => {
  it('세대를 올리면 그 전에 나간 쿠키는 통하지 않는다', async () => {
    const token = await freshToken();
    expect(await getSession(request(token))).not.toBeNull();

    await revokeSessions(PID);

    expect(await getSession(request(token))).toBeNull();
  });

  it('끊은 본인은 새 쿠키로 이어진다 — "다른 기기" 가 "나까지 전부" 가 되면 안 된다', async () => {
    const old = await freshToken();
    await revokeSessions(PID);
    const reissued = await freshToken();

    expect(await getSession(request(old))).toBeNull();
    expect(await getSession(request(reissued))).not.toBeNull();
  });

  it('비밀번호를 바꾸면 지난 세션이 함께 끊긴다 — 바꾸는 이유의 절반이 이것이다', async () => {
    const token = await freshToken();

    await setPlayerPassword(PID, 'new-password-1234');

    expect(await getSession(request(token))).toBeNull();
  });

  it('계정이 사라지면 만료를 기다리지 않고 즉시 끊긴다', async () => {
    const token = await freshToken();
    players.delete(PID);

    expect(await getSession(request(token))).toBeNull();
  });

  it('세대 번호만 고쳐 쓴 쿠키는 서명에서 걸린다', async () => {
    await revokeSessions(PID); // 지금 세대 = 1
    const stale = createSessionToken(PID, 0);
    const [body] = stale.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
        ep: 1,
      }),
    ).toString('base64url')}.${stale.split('.')[1]}`;

    expect(await getSession(request(forged))).toBeNull();
  });
});

describe('가드', () => {
  it('회수된 세션의 쓰기는 401', async () => {
    const token = await freshToken();
    await revokeSessions(PID);

    const guard = await requirePlayer(request(token));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(401);
  });

  it('관리자 권한을 떼면 다음 요청부터 403 — 쿠키를 새로 받을 필요가 없다', async () => {
    players.get(PID)!.is_admin = true;
    const token = await freshToken();
    expect((await requireAdmin(request(token))).ok).toBe(true);

    players.get(PID)!.is_admin = false;

    const guard = await requireAdmin(request(token));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(403);
  });

  it('쿠키가 없으면 DB 를 보지도 않는다 — 둘러보기만 하는 사람은 그대로', async () => {
    expect(await getSession(request(null))).toBeNull();
  });
});
