import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-types';

/**
 * 쓰기 경로의 신원 — **누구의 이름으로 남는가**.
 *
 * 예전에는 클라이언트가 `playerId` 를 적어 보냈고 서버가 그대로 믿었습니다.
 * 로그인이 없던 시절의 모양인데, 로그인이 생긴 뒤로는 숫자 하나만 바꾸면 남의
 * 이름으로 글·리뷰·투표가 남는 구멍이었습니다. 이제 근거는 서명된 세션 쿠키
 * 하나뿐입니다 (lib/auth.ts requirePlayer).
 *
 * 그래서 이 파일이 보는 것은 세 가지입니다.
 *   1. 저장되는 playerId 가 **세션의 것**인가
 *   2. 요청에 섞여 온 playerId 를 **무시**하는가
 *   3. 로그인하지 않은 쓰기를 **401 로 막는가** (제보만 예외 — 익명 허용)
 *
 * favorites-route.test.ts 와 같은 방식입니다 — 쿠키는 실제 서명 토큰을 쓰고,
 * DB 계층만 대역으로 세웁니다. 확인하려는 것은 SQL 이 아니라 신원입니다.
 */

const calls: { fn: string; args: unknown[] }[] = [];

/** 부른 사실과 인자만 남기는 대역 */
const rec =
  (fn: string, result?: unknown) =>
  async (...args: unknown[]) => {
    calls.push({ fn, args });
    return result;
  };

const POST_ROW = { id: 5, playerId: 42, title: '글', commentCount: 0 };

/**
 * 세션 판정이 이제 players 한 줄을 봅니다 — 서명이 맞아도 `token_epoch` 이
 * 다르거나 계정이 없으면 로그인이 아닙니다 (lib/auth.ts getSession, H12).
 * 이 파일이 보려는 건 신원이지 회수가 아니라서, 세대 0 으로 답하는 대역을 둡니다.
 */
vi.mock('@/lib/db', () => ({
  getDb: async () => ({
    query: async () => ({ rows: [{ nickname: '테스터', is_admin: false, token_epoch: 0 }] }),
  }),
}));

vi.mock('@/lib/board', () => ({
  createPost: vi.fn(rec('createPost', 5)),
  getPost: vi.fn(rec('getPost', POST_ROW)),
  listPosts: vi.fn(rec('listPosts', { posts: [], notices: [], total: 0 })),
  updatePost: vi.fn(rec('updatePost', true)),
  deletePost: vi.fn(rec('deletePost', true)),
  deletePostAsAdmin: vi.fn(rec('deletePostAsAdmin', true)),
  setLike: vi.fn(rec('setLike', { liked: true, likeCount: 1 })),
  createComment: vi.fn(rec('createComment')),
  createAttachment: vi.fn(rec('createAttachment', { id: 1, url: '/api/uploads/1' })),
  lastCommentOffset: () => 0,
}));

class NotClearedError extends Error {}

vi.mock('@/lib/tier', () => ({
  NotClearedError,
  DEFAULT_MACHINE_ID: 1,
  listGames: vi.fn(rec('listGames', [{ machineId: 1, name: '펌프' }])),
  listLevels: vi.fn(rec('listLevels', [{ mode: 'S', level: 15 }])),
  getTierBoard: vi.fn(rec('getTierBoard', { mode: 'S', level: 15, charts: [] })),
  setVote: vi.fn(rec('setVote')),
  setClear: vi.fn(rec('setClear')),
  setSpecial: vi.fn(rec('setSpecial')),
  getSettings: vi.fn(rec('getSettings', { voteMin: 1, voteMax: 20 })),
  getChartDetail: vi.fn(rec('getChartDetail', { id: 3 })),
}));

vi.mock('@/lib/arcades', () => ({
  getArcade: vi.fn(rec('getArcade', { id: 1, name: '오락실' })),
}));

vi.mock('@/lib/reviews', () => ({
  upsertReview: vi.fn(rec('upsertReview', { id: 1 })),
  listReviews: vi.fn(rec('listReviews', [])),
  deleteReview: vi.fn(rec('deleteReview', true)),
}));

class MachineNotAtArcadeError extends Error {}
class CabinetNotFoundError extends Error {}

/**
 * 실 DB 로 가는 두 길을 막습니다 — 이 파일은 신원만 봅니다.
 *   - isAdminRequest: 글 삭제가 "관리자인가" 를 요청마다 DB 로 확인합니다. 대역이 없으면
 *     .env.local 없는 환경에서 PGlite 콜드 스타트로 5초 타임아웃이 났습니다 (QA T1).
 *   - rate-limit: 제보 라우트가 시도 제한을 DB 카운터로 셉니다.
 */
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  isAdminRequest: vi.fn(async () => false),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  consume: vi.fn(async () => ({ allowed: true, count: 1, limit: 30, retryAfterMs: 0 })),
}));

vi.mock('@/lib/reports', () => ({
  MachineNotAtArcadeError,
  CabinetNotFoundError,
  createReport: vi.fn(rec('createReport', { report: { id: 1 } })),
  listReports: vi.fn(rec('listReports', [])),
}));

const posts = await import('@/app/api/posts/route');
const detail = await import('@/app/api/posts/[id]/route');
const like = await import('@/app/api/posts/[id]/like/route');
const tier = await import('@/app/api/tier/route');
const vote = await import('@/app/api/charts/[id]/vote/route');
const reviews = await import('@/app/api/arcades/[id]/reviews/route');
const reports = await import('@/app/api/arcades/[id]/reports/route');
const uploads = await import('@/app/api/uploads/route');

/** 경로 파라미터 — 라우트는 Promise 로 받는다 */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const cookieFor = (playerId: number) =>
  `${SESSION_COOKIE}=${createSessionToken(playerId, 0)}`;

/** 로그인한 사람의 요청 */
function signedIn(playerId: number, url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie: cookieFor(playerId) },
  });
}

const anonymous = (url: string, init?: RequestInit) =>
  new Request(`http://localhost${url}`, init);

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

/** 그 함수가 받은 인자 (없으면 undefined) */
const argsOf = (fn: string) => calls.find((c) => c.fn === fn)?.args;

beforeEach(() => {
  calls.length = 0;
});

describe('POST /api/posts — 글쓴이', () => {
  const body = { machineId: 1, category: 'free', title: '제목입니다', body: '내용입니다' };

  it('세션 주인의 이름으로 쓴다', async () => {
    const res = await posts.POST(signedIn(42, '/api/posts', json(body)));
    expect(res.status).toBe(201);
    expect((argsOf('createPost')?.[0] as { playerId: number }).playerId).toBe(42);
  });

  it('본문에 섞어 보낸 playerId 는 무시한다 — 남의 이름으로 쓸 수 없다', async () => {
    await posts.POST(signedIn(42, '/api/posts', json({ ...body, playerId: 999 })));
    expect((argsOf('createPost')?.[0] as { playerId: number }).playerId).toBe(42);
  });

  it('비로그인은 401 · 아무것도 저장하지 않는다', async () => {
    const res = await posts.POST(anonymous('/api/posts', json(body)));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/posts — 내 추천 여부', () => {
  it('쿼리스트링의 playerId 가 아니라 세션에서 읽는다', async () => {
    await posts.GET(signedIn(42, '/api/posts?playerId=999'));
    expect((argsOf('listPosts')?.[0] as { playerId: number }).playerId).toBe(42);
  });

  it('비로그인은 막지 않는다 — 개인 표시만 빠진다', async () => {
    const res = await posts.GET(anonymous('/api/posts?playerId=999'));
    expect(res.status).toBe(200);
    expect((argsOf('listPosts')?.[0] as { playerId: number | null }).playerId).toBeNull();
  });
});

/**
 * 추천은 이 브랜치에서 `POST` 토글이 아니라 `PUT`/`DELETE` 입니다 (멱등 —
 * app/api/posts/[id]/like 주석). 신원 이야기는 같습니다.
 */
describe('/api/posts/:id/like — 추천', () => {
  it('PUT — 세션 주인으로 켠다', async () => {
    await like.PUT(signedIn(42, '/api/posts/5/like', json({ playerId: 999 })), ctx('5'));
    expect(argsOf('setLike')).toEqual([5, 42, true]);
  });

  it('DELETE — 쿼리스트링이 아니라 세션 주인의 추천을 끈다', async () => {
    await like.DELETE(
      signedIn(42, '/api/posts/5/like?playerId=999', { method: 'DELETE' }),
      ctx('5'),
    );
    expect(argsOf('setLike')).toEqual([5, 42, false]);
  });

  it('PUT 은 본문이 없어도 된다 — 남은 것은 화면 복원용 곁가지뿐이다', async () => {
    const res = await like.PUT(
      signedIn(42, '/api/posts/5/like', { method: 'PUT' }),
      ctx('5'),
    );
    expect(res.status).toBe(200);
    expect(argsOf('setLike')).toEqual([5, 42, true]);
  });

  it('비로그인은 401', async () => {
    for (const res of [
      await like.PUT(anonymous('/api/posts/5/like', json({})), ctx('5'),),
      await like.DELETE(anonymous('/api/posts/5/like', { method: 'DELETE' }), ctx('5')),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });
});

/**
 * 글 수정·삭제. 삭제는 관리자에게도 열려 있는데(근거는 쿠키의 isAdmin), 일반
 * 사용자 경로만 `?playerId=` 를 받고 있었습니다 — 관리자 문은 잠긴 채 옆의
 * 창문이 열려 있던 셈입니다.
 */
describe('/api/posts/:id — 수정·삭제', () => {
  const body = { machineId: 1, category: 'free', title: '고친 제목', body: '고친 내용' };

  it('PUT — 세션 주인의 글만 고친다 (본문의 playerId 는 무시)', async () => {
    await detail.PUT(
      signedIn(42, '/api/posts/5', { ...json({ ...body, playerId: 999 }), method: 'PUT' }),
      ctx('5'),
    );
    expect(argsOf('updatePost')?.slice(0, 2)).toEqual([5, 42]);
    expect((argsOf('updatePost')?.[2] as { playerId: number }).playerId).toBe(42);
  });

  it('DELETE — 쿼리스트링의 playerId 로는 남의 글을 지울 수 없다', async () => {
    await detail.DELETE(
      signedIn(42, '/api/posts/5?playerId=999', { method: 'DELETE' }),
      ctx('5'),
    );
    expect(argsOf('deletePost')).toEqual([5, 42]);
    expect(argsOf('deletePostAsAdmin')).toBeUndefined();
  });

  it('비로그인은 401', async () => {
    for (const res of [
      await detail.PUT(anonymous('/api/posts/5', { ...json(body), method: 'PUT' }), ctx('5')),
      await detail.DELETE(anonymous('/api/posts/5?playerId=42', { method: 'DELETE' }), ctx('5')),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(calls.filter((c) => c.fn !== 'getPost')).toEqual([]);
  });

  it('GET — 내 추천 여부는 쿼리스트링이 아니라 세션에서 읽는다', async () => {
    await detail.GET(signedIn(42, '/api/posts/5?playerId=999'), ctx('5'));
    expect(argsOf('getPost')?.slice(0, 2)).toEqual([5, 42]);
  });
});

describe('GET /api/tier — 내 클리어·투표 표시', () => {
  it('쿼리스트링의 playerId 가 아니라 세션에서 읽는다', async () => {
    await tier.GET(signedIn(42, '/api/tier?machineId=1&playerId=999'));
    expect((argsOf('getTierBoard')?.[0] as { playerId: number }).playerId).toBe(42);
  });

  it('비로그인도 서열표는 본다 — 개인 표시만 빠진다', async () => {
    const res = await tier.GET(anonymous('/api/tier?machineId=1&playerId=999'));
    expect(res.status).toBe(200);
    expect((argsOf('getTierBoard')?.[0] as { playerId: number | null }).playerId).toBeNull();
  });
});

describe('PUT /api/charts/:id/vote — 체감 난이도', () => {
  it('세션 주인의 표로 저장한다', async () => {
    await vote.PUT(signedIn(42, '/api/charts/3/vote', json({ playerId: 999, value: 15 })), ctx('3'));
    expect(argsOf('setVote')).toEqual([42, 3, 15]);
  });

  it('비로그인은 401 — 클리어 게이트를 건드리기도 전에 막는다', async () => {
    const res = await vote.PUT(anonymous('/api/charts/3/vote', json({ value: 15 })), ctx('3'));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('/api/arcades/:id/reviews — 1인 1리뷰', () => {
  it('POST — 세션 주인의 리뷰로 UPSERT 한다', async () => {
    await reviews.POST(
      signedIn(42, '/api/arcades/1/reviews', json({ playerId: 999, rating: 5 })),
      ctx('1'),
    );
    expect((argsOf('upsertReview')?.[0] as { playerId: number }).playerId).toBe(42);
  });

  it('DELETE — 쿼리스트링이 아니라 세션 주인의 리뷰를 지운다', async () => {
    const res = await reviews.DELETE(
      signedIn(42, '/api/arcades/1/reviews?playerId=999', { method: 'DELETE' }),
      ctx('1'),
    );
    expect(res.status).toBe(200);
    expect(argsOf('deleteReview')).toEqual([1, 42]);
  });

  it('비로그인은 401', async () => {
    const res = await reviews.DELETE(
      anonymous('/api/arcades/1/reviews?playerId=42', { method: 'DELETE' }),
      ctx('1'),
    );
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('POST /api/uploads — 첨부', () => {
  it('비로그인은 401 · 본문을 읽기도 전에 막는다', async () => {
    const res = await uploads.POST(anonymous('/api/uploads', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

/**
 * 제보만 예외입니다 — 지나가다 본 것을 알려주는 자리라 로그인을 요구하지
 * 않습니다. 대신 익명(null)은 있어요/없어졌어요 임계값에 세지 않습니다.
 */
describe('POST /api/arcades/:id/reports — 제보는 익명도 받는다', () => {
  const body = { machineId: 2, kind: 'presence' };

  it('로그인했으면 세션 주인의 제보다', async () => {
    const res = await reports.POST(
      signedIn(42, '/api/arcades/1/reports', json({ ...body, playerId: 999 })),
      ctx('1'),
    );
    expect(res.status).toBe(201);
    expect((argsOf('createReport')?.[0] as { playerId: number }).playerId).toBe(42);
  });

  it('비로그인은 401 이 아니라 익명 제보(playerId = null)다', async () => {
    const res = await reports.POST(anonymous('/api/arcades/1/reports', json(body)), ctx('1'));
    expect(res.status).toBe(201);
    expect((argsOf('createReport')?.[0] as { playerId: number | null }).playerId).toBeNull();
  });

  it('비로그인이 남의 번호를 적어도 익명이다', async () => {
    await reports.POST(
      anonymous('/api/arcades/1/reports', json({ ...body, playerId: 999 })),
      ctx('1'),
    );
    expect((argsOf('createReport')?.[0] as { playerId: number | null }).playerId).toBeNull();
  });
});
