import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 비밀번호 찾기 라우트 (app/api/auth/password-reset/**) — **문지기**.
 *
 * 1. 요청은 계정이 있든 없든 같은 답이고, 찾기 · 발송은 응답 뒤(after)에 돈다 — 계정 존재를 캐 볼 수 없게
 * 2. 시도 제한 키는 정규화한 아이디(대소문자 · 공백 · NFC)와 믿을 수 있는 주소뿐
 * 3. 메일을 못 보내는 때는 503 (계정과 무관한 서버 사정)
 * 4. 링크를 쓸 수 없으면 409 + reason, 쓰면 세션 쿠키를 심는다
 * 판정 자체는 tests/password-reset.test.ts 가 봅니다.
 */

const pending: (() => Promise<void>)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => {
    pending.push(fn);
  },
}));

const auth = {
  takeLoginAttempt: vi.fn(async (_key: string) => 0),
  clientKey: vi.fn((_req: Request): string | null => null),
  suspensionMessage: vi.fn(async (_id: number): Promise<string | null> => null),
  setSessionCookie: vi.fn(async (res: Response) => {
    res.headers.append('set-cookie', 'af_session=test; Path=/; HttpOnly');
    return res;
  }),
};
vi.mock('@/lib/auth', () => auth);

const lib = {
  available: true,
  requestPasswordReset: vi.fn(async () => 'no-target' as const),
  checkPasswordReset: vi.fn(async () => 'ok' as const),
  consumePasswordReset: vi.fn(
    async (): Promise<{ ok: true; playerId: number; nickname: string } | { ok: false; reason: 'expired' }> => ({
      ok: true,
      playerId: 7,
      nickname: 'pumlin',
    }),
  ),
};
vi.mock('@/lib/password-reset', () => ({
  isPasswordResetAvailable: () => lib.available,
  normalizeIdentifier: (raw: string) => raw.normalize('NFC').trim().toLowerCase(),
  requestPasswordReset: lib.requestPasswordReset,
  checkPasswordReset: lib.checkPasswordReset,
  consumePasswordReset: lib.consumePasswordReset,
}));

const reset = await import('@/app/api/auth/password-reset/route');
const check = await import('@/app/api/auth/password-reset/check/route');
const confirm = await import('@/app/api/auth/password-reset/confirm/route');

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  pending.length = 0;
  lib.available = true;
  vi.clearAllMocks();
  auth.takeLoginAttempt.mockResolvedValue(0);
  auth.clientKey.mockReturnValue(null);
});

describe('POST /api/auth/password-reset — 링크 메일 요청', () => {
  it('있는 계정이든 없는 계정이든 같은 답이고, 찾기는 응답 뒤에 돈다', async () => {
    const a = await reset.POST(post('/api/auth/password-reset', { identifier: 'pumlin' }));
    const b = await reset.POST(post('/api/auth/password-reset', { identifier: 'nobody@example.com' }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    // 응답을 만드는 동안에는 찾지 않았다
    expect(lib.requestPasswordReset).not.toHaveBeenCalled();
    await Promise.all(pending.map((fn) => fn()));
    expect(lib.requestPasswordReset).toHaveBeenCalledTimes(2);
    expect(lib.requestPasswordReset).toHaveBeenCalledWith('pumlin', 'http://localhost');
  });

  it('시도 제한 키는 정규화한 아이디 — 대소문자로 카운터를 초기화할 수 없다', async () => {
    await reset.POST(post('/api/auth/password-reset', { identifier: '  PumLin ' }));
    expect(auth.takeLoginAttempt).toHaveBeenCalledWith('reset:pumlin');
    expect(auth.takeLoginAttempt).toHaveBeenCalledTimes(1); // 믿을 주소가 없으면 주소로는 세지 않는다
  });

  it('잠기면 429 와 남은 시간, 메일은 보내지 않는다', async () => {
    auth.takeLoginAttempt.mockResolvedValue(5 * 60_000);
    const res = await reset.POST(post('/api/auth/password-reset', { identifier: 'pumlin' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('300');
    expect(pending).toHaveLength(0);
  });

  it('빈 칸은 400 과 할 일', async () => {
    const res = await reset.POST(post('/api/auth/password-reset', { identifier: '   ' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('아이디나 이메일을 입력해 주세요');
  });

  it('메일을 보낼 수 없는 때는 503, GET 은 그 사실을 알린다', async () => {
    lib.available = false;
    const res = await reset.POST(post('/api/auth/password-reset', { identifier: 'pumlin' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('메일로 비밀번호를 찾을 수 없어요');
    const status = await (await reset.GET(new Request('http://localhost/api/auth/password-reset'))).json();
    expect(status.available).toBe(false);
  });
});

describe('check · confirm — 링크로 새 비밀번호', () => {
  it('check 는 상태만 돌려준다', async () => {
    const res = await check.POST(post('/api/auth/password-reset/check', { token: 'abc' }));
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(lib.consumePasswordReset).not.toHaveBeenCalled();
  });

  it('두 비밀번호가 다르거나 짧으면 400', async () => {
    const diff = await confirm.POST(
      post('/api/auth/password-reset/confirm', { token: 'abc', password: 'long-enough-1', passwordConfirm: 'other-pass-2' }),
    );
    expect(diff.status).toBe(400);
    expect((await diff.json()).error).toBe('두 비밀번호가 달라요. 다시 확인해 주세요');
    const short = await confirm.POST(
      post('/api/auth/password-reset/confirm', { token: 'abc', password: 'short', passwordConfirm: 'short' }),
    );
    expect(short.status).toBe(400);
    expect(lib.consumePasswordReset).not.toHaveBeenCalled();
  });

  it('바꾸면 로그인 쿠키를 심고 user 를 돌려준다', async () => {
    const res = await confirm.POST(
      post('/api/auth/password-reset/confirm', { token: 'abc', password: 'long-enough-1', passwordConfirm: 'long-enough-1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { playerId: 7, nickname: 'pumlin', isAdmin: false } });
    expect(res.headers.get('set-cookie')).toContain('af_session=');
  });

  it('정지된 계정은 비밀번호만 바뀌고 로그인시키지 않는다', async () => {
    auth.suspensionMessage.mockResolvedValueOnce('정지 중이에요');
    const res = await confirm.POST(
      post('/api/auth/password-reset/confirm', { token: 'abc', password: 'long-enough-1', passwordConfirm: 'long-enough-1' }),
    );
    expect(await res.json()).toEqual({ user: null, suspended: '정지 중이에요' });
    expect(auth.setSessionCookie).not.toHaveBeenCalled();
  });

  it('링크를 쓸 수 없으면 409 + reason', async () => {
    lib.consumePasswordReset.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    const res = await confirm.POST(
      post('/api/auth/password-reset/confirm', { token: 'abc', password: 'long-enough-1', passwordConfirm: 'long-enough-1' }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('expired');
    expect(body.error).toContain('새 링크를 받아 주세요');
  });
});
