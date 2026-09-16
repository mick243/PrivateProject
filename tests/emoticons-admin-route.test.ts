import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/lib/auth-types';
import { createSessionToken } from '@/lib/auth';

/**
 * 이모티콘 관리 라우트 — **누가 부르는가**와 **soft delete 의 모양**을 봅니다.
 *
 * 관리 목록은 지운 것·올린 사람까지 보이는 관리자용이라 비로그인·일반 사용자는
 * 문을 열어 주면 안 됩니다. 판정은 화면(useIsAdmin)이 아니라 여기입니다.
 * DB 와 lib/emoticons 는 대역으로 세웁니다 — SQL 은 그 파일의 일입니다.
 */

const calls: { fn: string; args: unknown[] }[] = [];
let isAdmin = false;

vi.mock('@/lib/db', () => ({
  getDb: async () => ({
    query: async () => ({ rows: [{ nickname: '테스터', is_admin: isAdmin, token_epoch: 0 }] }),
  }),
}));

vi.mock('@/lib/emoticons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emoticons')>();
  return {
    ...actual,
    listEmoticonsForAdmin: vi.fn(async (...args: unknown[]) => {
      calls.push({ fn: 'list', args });
      return { rows: [], total: 0 };
    }),
    deleteEmoticon: vi.fn(async (...args: unknown[]) => {
      calls.push({ fn: 'delete', args });
      return true;
    }),
    restoreEmoticon: vi.fn(async (...args: unknown[]) => {
      calls.push({ fn: 'restore', args });
      return true;
    }),
    renameEmoticon: vi.fn(async (...args: unknown[]) => {
      calls.push({ fn: 'rename', args });
      if (args[1] === '중복') throw new actual.EmoticonNameTakenError();
      return true;
    }),
  };
});

const { GET } = await import('@/app/api/emoticons/admin/route');
const { DELETE, PATCH } = await import('@/app/api/emoticons/[id]/route');

function as(admin: boolean, url: string, init?: RequestInit): Request {
  isAdmin = admin;
  const token = createSessionToken(7, 0);
  return new Request(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie: `${SESSION_COOKIE}=${token}` },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  calls.length = 0;
  isAdmin = false;
});

describe('GET /api/emoticons/admin', () => {
  it('비로그인은 401, DB 목록을 묻지 않는다', async () => {
    const res = await GET(new Request('http://localhost/api/emoticons/admin'));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('일반 사용자는 403', async () => {
    const res = await GET(as(false, 'http://localhost/api/emoticons/admin'));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('관리자 — 쿼리를 다듬어 넘기고 다듬은 값을 돌려준다', async () => {
    const res = await GET(
      as(true, 'http://localhost/api/emoticons/admin?status=deleted&page=3&pageSize=999&q=%20박수%20'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], total: 0, page: 3, pageSize: 100 });
    expect(calls).toEqual([
      { fn: 'list', args: [{ status: 'deleted', page: 3, pageSize: 100, q: '박수' }] },
    ]);
  });

  it('잘못된 값은 400 이 아니라 기본값 — 목록 화면은 늘 떠야 한다', async () => {
    const res = await GET(as(true, 'http://localhost/api/emoticons/admin?status=nope&page=-1'));
    expect(res.status).toBe(200);
    expect(calls[0].args[0]).toEqual({ status: 'live', page: 1, pageSize: 24, q: '' });
  });
});

describe('DELETE · PATCH /api/emoticons/:id', () => {
  it('일반 사용자는 빼지도 되살리지도 못한다', async () => {
    expect((await DELETE(as(false, 'http://localhost/api/emoticons/3'), ctx('3'))).status).toBe(403);
    expect(
      (await PATCH(as(false, 'http://localhost/api/emoticons/3', json({ restore: true })), ctx('3'))).status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });

  it('빼기는 soft delete 함수를 부른다', async () => {
    const res = await DELETE(as(true, 'http://localhost/api/emoticons/3'), ctx('3'));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ fn: 'delete', args: [3] }]);
  });

  it('{ restore: true } 는 되살린다', async () => {
    const res = await PATCH(as(true, 'http://localhost/api/emoticons/3', json({ restore: true })), ctx('3'));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ fn: 'restore', args: [3] }]);
  });

  it('{ name } 은 다듬어서 바꾼다', async () => {
    const res = await PATCH(as(true, 'http://localhost/api/emoticons/3', json({ name: '  큰   박수 ' })), ctx('3'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: '큰 박수' });
    expect(calls).toEqual([{ fn: 'rename', args: [3, '큰 박수'] }]);
  });

  it('이름이 겹치면 409', async () => {
    const res = await PATCH(as(true, 'http://localhost/api/emoticons/3', json({ name: '중복' })), ctx('3'));
    expect(res.status).toBe(409);
  });

  it('빈 이름 · 둘 다 없는 본문 · 이상한 id 는 400', async () => {
    expect((await PATCH(as(true, 'http://localhost/api/emoticons/3', json({ name: '   ' })), ctx('3'))).status).toBe(400);
    expect((await PATCH(as(true, 'http://localhost/api/emoticons/3', json({})), ctx('3'))).status).toBe(400);
    expect((await PATCH(as(true, 'http://localhost/api/emoticons/x', json({ restore: true })), ctx('x'))).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
