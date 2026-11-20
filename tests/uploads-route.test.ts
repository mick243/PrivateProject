import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-types';

/**
 * POST /api/uploads 의 상한 (2026-11-20).
 *
 * 예전에는 로그인만 하면 횟수 · 용량 제한 없이 올릴 수 있었고, 길이를 밝히지 않은 본문은 사전
 * 검사를 지나 통째로 메모리에 올라갔습니다. 여기 못 박는 것은 **본문을 읽기 전에** 거절한다는
 * 것입니다 — 거절할 요청의 50MB 를 받아 놓고 413 을 주면 상한이 방어 구실을 못 합니다.
 * DB · 디스크는 건드리지 않습니다(대역).
 */

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    players: { findUnique: async () => ({ nickname: '테스터', is_admin: false, token_epoch: 0 }) },
  }),
}));

let rate = { allowed: true, count: 1, limit: 30, retryAfterMs: 0 };
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  consume: vi.fn(async () => rate),
}));

let usedBytes = 0;
const purge = vi.fn(async () => ({ rows: 0, files: 0 }));
vi.mock('@/lib/upload-housekeeping', () => ({
  bytesUploadedLastDay: vi.fn(async () => usedBytes),
  purgeOrphanAttachments: (...a: unknown[]) => purge(...(a as [])),
}));

const save = vi.fn(async (buf: Buffer) => ({ storageKey: 'k.png', mime: 'image/png', bytes: buf.byteLength }));
vi.mock('@/lib/uploads', async (orig) => ({
  ...(await orig<typeof import('@/lib/uploads')>()),
  save: (b: Buffer) => save(b),
}));

vi.mock('@/lib/board', () => ({
  createAttachment: vi.fn(async (input: { bytes: number }) => ({ id: 7, url: '/api/uploads/7', bytes: input.bytes, mime: 'image/png' })),
}));

const { POST } = await import('@/app/api/uploads/route');

const cookie = `${SESSION_COOKIE}=${createSessionToken(42, 0)}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/**
 * multipart 본문을 만들고 Content-Length 를 마음대로 붙인다.
 * 'real' = 실제 길이 · 'none' = 헤더 없음(chunked 흉내) · 숫자 = 그 값으로 거짓 신고.
 */
async function upload(length: 'real' | 'none' | number, size?: number): Promise<Request> {
  const form = new FormData();
  form.set('file', new File([size ? Buffer.alloc(size, 1) : PNG], 'a.png', { type: 'image/png' }));
  const probe = new Request('http://localhost/x', { method: 'POST', body: form });
  const body = Buffer.from(await probe.arrayBuffer());
  const headers = new Headers({ 'content-type': probe.headers.get('content-type')!, cookie });
  if (length !== 'none') headers.set('content-length', String(length === 'real' ? body.byteLength : length));
  return new Request('http://localhost/api/uploads', { method: 'POST', headers, body });
}

beforeEach(() => {
  rate = { allowed: true, count: 1, limit: 30, retryAfterMs: 0 };
  usedBytes = 0;
  save.mockClear();
  purge.mockClear();
});

describe('POST /api/uploads — 상한', () => {
  it('정상 업로드는 201 이고, 덤으로 버려진 첨부를 조금 치운다', async () => {
    const res = await POST(await upload('real'));
    expect(res.status).toBe(201);
    expect(save).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledWith({ limit: 20 });
  });

  it('길이를 밝히지 않으면 411 — 본문을 읽지 않는다', async () => {
    const res = await POST(await upload('none'));
    expect(res.status).toBe(411);
    expect(save).not.toHaveBeenCalled();
  });

  it('밝힌 길이가 상한을 넘으면 413 — 본문을 읽지 않는다', async () => {
    const res = await POST(await upload(60 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(save).not.toHaveBeenCalled();
  });

  it('한 시간 횟수를 넘기면 429 와 Retry-After', async () => {
    rate = { allowed: false, count: 31, limit: 30, retryAfterMs: 600_000 };
    const res = await POST(await upload('real'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect(((await res.json()) as { error: string }).error).toContain('30개');
    expect(save).not.toHaveBeenCalled();
  });

  it('24시간 총량을 넘기면 429 — 이미 올린 양 + 이번 길이로 판단한다', async () => {
    usedBytes = 300 * 1024 * 1024;
    const res = await POST(await upload('real'));
    // 1MB 여유 안이면 통과
    expect(res.status).toBe(201);

    usedBytes = 299 * 1024 * 1024;
    const big = await POST(await upload('real', 4 * 1024 * 1024));
    expect(big.status).toBe(429);
    expect(((await big.json()) as { error: string }).error).toContain('300MB');
  });

  it('비로그인은 401 — 상한 계산도 하지 않는다', async () => {
    const res = await POST(new Request('http://localhost/api/uploads', { method: 'POST' }));
    expect(res.status).toBe(401);
  });
});
