import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/lib/auth-types';
import { createSessionToken } from '@/lib/auth';

/**
 * 리뷰 · 투표 라우트의 신뢰 장치 (2026-10-28 QA 에서 드러난 것).
 *
 *   - 방금 만든 계정은 투표 · 특수 패턴 · 리뷰를 남길 수 없다 (관리자는 예외)
 *   - 관리자는 남의 리뷰를 지울 수 있고, 일반 사용자는 남의 리뷰를 못 지운다
 *
 * DB 는 대역입니다. 플레이어 한 줄이 세션 판정(getSession)과 가입 시각
 * (lib/account-age.ts) 양쪽에 쓰이므로 같은 표에서 답합니다.
 */

const HOUR = 60 * 60 * 1000;
const players: Record<number, { nickname: string; is_admin: boolean; token_epoch: number; created_at: Date }> = {};

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    players: {
      findUnique: async ({ where }: { where: { id: number } }) => players[where.id] ?? null,
    },
  }),
}));

const calls: { fn: string; args: unknown[] }[] = [];

vi.mock('@/lib/reviews', () => ({
  listReviews: vi.fn(async () => []),
  upsertReview: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'upsert', args });
    return { id: 1 };
  }),
  deleteReview: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'deleteOwn', args });
    return true;
  }),
  deleteReviewById: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'deleteById', args });
    return args[1] !== 404;
  }),
}));

vi.mock('@/lib/arcades', () => ({
  getArcade: vi.fn(async (id: number) => ({ id, name: '오락실' })),
}));

vi.mock('@/lib/tier', () => ({
  NotClearedError: class NotClearedError extends Error {},
  getSettings: vi.fn(async () => ({ voteMin: -1, voteMax: 1 })),
  getChartDetail: vi.fn(async (id: number) => ({ id })),
  setVote: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'vote', args });
  }),
  setSpecial: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'special', args });
  }),
}));

const reviews = await import('@/app/api/arcades/[id]/reviews/route');
const vote = await import('@/app/api/charts/[id]/vote/route');
const special = await import('@/app/api/charts/[id]/special/route');

/** 그 플레이어로 로그인한 요청 */
function as(playerId: number, url: string, init?: RequestInit): Request {
  const token = createSessionToken(playerId, 0);
  return new Request(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}), cookie: `${SESSION_COOKIE}=${token}` },
  });
}

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

const NEW = 1; // 5분 전에 가입
const OLD = 2; // 사흘 전에 가입
const ADMIN_NEW = 3; // 관리자 · 방금 생김

beforeEach(() => {
  calls.length = 0;
  const now = Date.now();
  players[NEW] = { nickname: '새계정', is_admin: false, token_epoch: 0, created_at: new Date(now - 5 * 60 * 1000) };
  players[OLD] = { nickname: '오래된계정', is_admin: false, token_epoch: 0, created_at: new Date(now - 72 * HOUR) };
  players[ADMIN_NEW] = { nickname: '관리자', is_admin: true, token_epoch: 0, created_at: new Date(now - 60 * 1000) };
});

describe('POST /api/arcades/:id/reviews — 막 만든 계정', () => {
  const post = (playerId: number) =>
    reviews.POST(
      as(playerId, 'http://localhost/api/arcades/44/reviews', {
        method: 'POST',
        body: JSON.stringify({ rating: 5, body: '' }),
      }),
      ctx(44),
    );

  it('가입 하루 전이면 403 과 남은 시간을 돌려주고 저장하지 않는다', async () => {
    const res = await post(NEW);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/24시간이 지나야 리뷰를 남길 수 있습니다/);
    expect(calls.find((c) => c.fn === 'upsert')).toBeUndefined();
  });

  it('하루가 지난 계정은 저장한다', async () => {
    const res = await post(OLD);
    expect(res.status).toBe(201);
    expect(calls.find((c) => c.fn === 'upsert')).toBeDefined();
  });

  it('관리자는 막 생긴 계정이어도 막지 않는다', async () => {
    expect((await post(ADMIN_NEW)).status).toBe(201);
  });
});

describe('DELETE /api/arcades/:id/reviews?reviewId= — 관리자의 리뷰 삭제', () => {
  const del = (playerId: number, query: string) =>
    reviews.DELETE(as(playerId, `http://localhost/api/arcades/44/reviews${query}`, { method: 'DELETE' }), ctx(44));

  it('관리자는 남의 리뷰를 번호로 지운다', async () => {
    const res = await del(ADMIN_NEW, '?reviewId=9');
    expect(res.status).toBe(200);
    expect(calls).toContainEqual({ fn: 'deleteById', args: [44, 9] });
  });

  it('일반 사용자가 번호를 붙이면 403 이고 아무것도 지우지 않는다', async () => {
    const res = await del(OLD, '?reviewId=9');
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('없는 리뷰면 404', async () => {
    expect((await del(ADMIN_NEW, '?reviewId=404')).status).toBe(404);
  });

  it('번호가 잘못되면 400', async () => {
    expect((await del(ADMIN_NEW, '?reviewId=abc')).status).toBe(400);
  });

  it('번호가 없으면 예전처럼 내 리뷰를 지운다', async () => {
    const res = await del(OLD, '');
    expect(res.status).toBe(200);
    expect(calls).toContainEqual({ fn: 'deleteOwn', args: [44, OLD] });
  });
});

describe('PUT /api/charts/:id/vote — 막 만든 계정', () => {
  const put = (playerId: number) =>
    vote.PUT(
      as(playerId, 'http://localhost/api/charts/7/vote', { method: 'PUT', body: JSON.stringify({ value: 0.5 }) }),
      ctx(7),
    );

  it('가입 하루 전이면 403 이고 표를 남기지 않는다', async () => {
    const res = await put(NEW);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/투표할 수 있습니다/);
    expect(calls).toHaveLength(0);
  });

  it('하루가 지난 계정은 표를 남긴다', async () => {
    expect((await put(OLD)).status).toBe(200);
    expect(calls).toContainEqual({ fn: 'vote', args: [OLD, 7, 0.5] });
  });

  it('관리자는 막지 않는다', async () => {
    expect((await put(ADMIN_NEW)).status).toBe(200);
  });

  it('투표 취소는 막 만든 계정도 할 수 있다', async () => {
    const res = await vote.DELETE(as(NEW, 'http://localhost/api/charts/7/vote', { method: 'DELETE' }), ctx(7));
    expect(res.status).toBe(200);
    expect(calls).toContainEqual({ fn: 'vote', args: [NEW, 7, null] });
  });
});

describe('PUT /api/charts/:id/special — 막 만든 계정', () => {
  it('켜기는 막고 끄기는 막지 않는다', async () => {
    const on = await special.PUT(as(NEW, 'http://localhost/api/charts/7/special', { method: 'PUT' }), ctx(7));
    expect(on.status).toBe(403);
    const off = await special.DELETE(as(NEW, 'http://localhost/api/charts/7/special', { method: 'DELETE' }), ctx(7));
    expect(off.status).toBe(200);
    expect(calls).toEqual([{ fn: 'special', args: [NEW, 7, false] }]);
  });
});
