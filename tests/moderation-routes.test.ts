import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-types';

/**
 * 신고 · 차단 · 계정 정지 · AI 추정 검수 라우트 (2026-11-20, db/migrate-083).
 *
 * 여기 못 박는 것은 **문지기**입니다 — 누가 부를 수 있는지, 입력을 어디서 거르는지, 서버 함수의
 * 오류가 어떤 상태 코드가 되는지. 실제 SQL 은 사본 DB 로 띄운 서버에서 확인했습니다(커밋 메시지).
 * 세션 판정의 정지 처리(getSession)도 여기서 봅니다 — 정지한 계정의 쿠키가 통하면 정지가 무의미합니다.
 */

/** players 한 줄 대역 — 테스트마다 바꿉니다 */
const rows: Record<number, { nickname: string; is_admin: boolean; token_epoch: number; suspended_until: Date | null; suspended_reason?: string | null }> = {};
vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    players: {
      findUnique: async ({ where }: { where: { id: number } }) => rows[where.id] ?? null,
    },
  }),
}));

vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  consume: vi.fn(async () => ({ allowed: true, count: 1, limit: 20, retryAfterMs: 0 })),
}));

const mod = {
  createContentReport: vi.fn(async (): Promise<{ duplicate: boolean }> => ({ duplicate: false })),
  listReportGroups: vi.fn(async () => []),
  resolveReports: vi.fn(async () => ({ resolved: 2, deleted: true })),
  listBlocked: vi.fn(async () => []),
  setBlock: vi.fn(async () => true),
  listPlayersForAdmin: vi.fn(async () => []),
  suspendPlayer: vi.fn(async () => ({ until: '2026-11-27T00:00:00.000Z' })),
  unsuspendPlayer: vi.fn(async () => true),
  listGuessesForReview: vi.fn(async () => []),
  approveGuess: vi.fn(async () => true),
  rejectGuess: vi.fn(async () => true),
};
vi.mock('@/lib/moderation', async () => {
  class ReportError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  class SuspendError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return { ...mod, ReportError, SuspendError };
});

const reports = await import('@/app/api/content-reports/route');
const blocks = await import('@/app/api/blocks/route');
const adminReports = await import('@/app/api/admin/reports/route');
const suspension = await import('@/app/api/admin/players/[id]/suspension/route');
const guesses = await import('@/app/api/admin/guesses/route');
const { getSession } = await import('@/lib/auth');
const { ReportError, SuspendError } = (await import('@/lib/moderation')) as unknown as {
  ReportError: new (m: string, s: number) => Error;
  SuspendError: new (m: string, s: number) => Error;
};

const USER = 2;
const ADMIN = 13;
const cookie = (id: number, ep = 0) => `${SESSION_COOKIE}=${createSessionToken(id, ep)}`;
const req = (path: string, init: { method?: string; as?: number; body?: unknown } = {}) =>
  new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.as ? { cookie: cookie(init.as) } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[Number(k)];
  rows[USER] = { nickname: '발바닥', is_admin: false, token_epoch: 0, suspended_until: null };
  rows[ADMIN] = { nickname: '관리자', is_admin: true, token_epoch: 0, suspended_until: null };
  for (const f of Object.values(mod)) f.mockClear();
});

describe('getSession — 정지된 계정', () => {
  it('정지 기한 안이면 쿠키가 맞아도 로그인이 아니다', async () => {
    rows[USER]!.suspended_until = new Date(Date.now() + 60_000);
    expect(await getSession(req('/', { as: USER }))).toBeNull();
  });

  it('기한이 지났으면 다시 로그인이다', async () => {
    rows[USER]!.suspended_until = new Date(Date.now() - 60_000);
    expect((await getSession(req('/', { as: USER })))?.playerId).toBe(USER);
  });
});

describe('POST /api/content-reports', () => {
  const body = { targetType: 'post', targetId: 30, reason: 'spam' };

  it('비로그인은 401 — 서버 함수를 부르지 않는다', async () => {
    const res = await reports.POST(req('/api/content-reports', { method: 'POST', body }));
    expect(res.status).toBe(401);
    expect(mod.createContentReport).not.toHaveBeenCalled();
  });

  it('모르는 사유 · 종류는 400', async () => {
    for (const bad of [{ ...body, reason: 'nope' }, { ...body, targetType: 'player' }, { ...body, targetId: 0 }]) {
      const res = await reports.POST(req('/api/content-reports', { method: 'POST', as: USER, body: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(mod.createContentReport).not.toHaveBeenCalled();
  });

  it('신고한 사람은 세션이 정한다 (본문의 값을 믿지 않는다)', async () => {
    const res = await reports.POST(req('/api/content-reports', { method: 'POST', as: USER, body: { ...body, reporterId: 999 } }));
    expect(res.status).toBe(201);
    expect(mod.createContentReport).toHaveBeenCalledWith(expect.objectContaining({ reporterId: USER, targetId: 30 }));
  });

  it('같은 대상을 다시 신고하면 200 + duplicate', async () => {
    mod.createContentReport.mockResolvedValueOnce({ duplicate: true });
    const res = await reports.POST(req('/api/content-reports', { method: 'POST', as: USER, body }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
  });

  it('서버 함수의 거절(없는 글 · 내 글)은 그 상태 코드로', async () => {
    mod.createContentReport.mockRejectedValueOnce(new ReportError('내가 쓴 글은 신고할 수 없어요.', 400));
    const res = await reports.POST(req('/api/content-reports', { method: 'POST', as: USER, body }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('내가 쓴 글');
  });

  it('정지된 계정은 신고할 수 없다 (401)', async () => {
    rows[USER]!.suspended_until = new Date(Date.now() + 60_000);
    const res = await reports.POST(req('/api/content-reports', { method: 'POST', as: USER, body }));
    expect(res.status).toBe(401);
  });
});

describe('/api/blocks', () => {
  it('차단은 PUT, 풀기는 DELETE ?playerId — 둘 다 세션 주인 기준', async () => {
    expect((await blocks.PUT(req('/api/blocks', { method: 'PUT', as: USER, body: { playerId: 7 } }))).status).toBe(200);
    expect(mod.setBlock).toHaveBeenLastCalledWith(USER, 7, true);
    expect((await blocks.DELETE(req('/api/blocks?playerId=7', { method: 'DELETE', as: USER }))).status).toBe(200);
    expect(mod.setBlock).toHaveBeenLastCalledWith(USER, 7, false);
  });

  it('상대가 없으면 404, id 가 이상하면 400, 비로그인은 401', async () => {
    mod.setBlock.mockResolvedValueOnce(false);
    expect((await blocks.PUT(req('/api/blocks', { method: 'PUT', as: USER, body: { playerId: 7 } }))).status).toBe(404);
    expect((await blocks.DELETE(req('/api/blocks?playerId=abc', { method: 'DELETE', as: USER }))).status).toBe(400);
    expect((await blocks.GET(req('/api/blocks'))).status).toBe(401);
  });
});

describe('관리자 라우트는 관리자만', () => {
  const calls: [string, () => Promise<Response>][] = [
    ['GET 신고함', () => adminReports.GET(req('/api/admin/reports', { as: USER }))],
    ['PUT 신고 처리', () => adminReports.PUT(req('/api/admin/reports', { method: 'PUT', as: USER, body: { targetType: 'post', targetId: 1, action: 'delete' } }))],
    ['PUT 정지', () => suspension.PUT(req('/x', { method: 'PUT', as: USER, body: { days: 1 } }), ctx('7'))],
    ['DELETE 정지', () => suspension.DELETE(req('/x', { method: 'DELETE', as: USER }), ctx('7'))],
    ['PUT 추정 승인', () => guesses.PUT(req('/api/admin/guesses', { method: 'PUT', as: USER, body: { arcadeId: 1, machineId: 1 } }))],
    ['DELETE 추정', () => guesses.DELETE(req('/api/admin/guesses?arcadeId=1&machineId=1', { method: 'DELETE', as: USER }))],
  ];
  for (const [label, call] of calls) {
    it(`${label} — 일반 사용자는 403, 서버 함수는 그대로`, async () => {
      expect((await call()).status).toBe(403);
      expect(mod.resolveReports).not.toHaveBeenCalled();
      expect(mod.suspendPlayer).not.toHaveBeenCalled();
      expect(mod.approveGuess).not.toHaveBeenCalled();
      expect(mod.rejectGuess).not.toHaveBeenCalled();
    });
  }
});

describe('관리자 동작', () => {
  it('신고 처리는 처리한 관리자를 세션에서 적는다', async () => {
    const res = await adminReports.PUT(req('/api/admin/reports', { method: 'PUT', as: ADMIN, body: { targetType: 'post', targetId: 30, action: 'delete' } }));
    expect(res.status).toBe(200);
    expect(mod.resolveReports).toHaveBeenCalledWith({ targetType: 'post', targetId: 30, action: 'delete', adminId: ADMIN });
  });

  it('정지: days=null 은 무기한, 기간 밖이면 400, 관리자 대상 거절은 그 상태 코드로', async () => {
    expect((await suspension.PUT(req('/x', { method: 'PUT', as: ADMIN, body: { days: null, reason: '도배' } }), ctx('7'))).status).toBe(200);
    expect(mod.suspendPlayer).toHaveBeenLastCalledWith({ playerId: 7, days: null, reason: '도배' });
    expect((await suspension.PUT(req('/x', { method: 'PUT', as: ADMIN, body: { days: 0 } }), ctx('7'))).status).toBe(400);
    mod.suspendPlayer.mockRejectedValueOnce(new SuspendError('관리자 계정은 정지할 수 없습니다', 400));
    expect((await suspension.PUT(req('/x', { method: 'PUT', as: ADMIN, body: { days: 1 } }), ctx('13'))).status).toBe(400);
  });

  it('추정 승인: 없는 추정이면 404', async () => {
    mod.approveGuess.mockResolvedValueOnce(false);
    const res = await guesses.PUT(req('/api/admin/guesses', { method: 'PUT', as: ADMIN, body: { arcadeId: 1, machineId: 1 } }));
    expect(res.status).toBe(404);
  });
});
