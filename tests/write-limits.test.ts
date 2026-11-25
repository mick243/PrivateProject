import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 글 · 댓글 시간당 상한 (2026-11-25, SSOT R28 의 일부). DB 카운터는 대역으로 세웁니다 —
 * 보려는 것은 키를 사람 · 종류별로 나눠 세는지와, 넘었을 때 429 와 안내 문구입니다.
 */
const calls: { key: string; limit: number; windowMs: number }[] = [];
let allowed = true;

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  consume: vi.fn(async (key: string, limit: number, windowMs: number) => {
    calls.push({ key, limit, windowMs });
    return { allowed, count: allowed ? 1 : limit + 1, limit, retryAfterMs: allowed ? 0 : 20 * 60 * 1000 };
  }),
}));

const { checkWriteLimit, WRITE_LIMITS } = await import('@/lib/write-limits');
const { HOUR_MS } = await import('@/lib/rate-limit');

beforeEach(() => {
  calls.length = 0;
  allowed = true;
});

describe('checkWriteLimit', () => {
  it('넘지 않았으면 null — 사람 · 종류별 키로 한 시간 창을 센다', async () => {
    expect(await checkWriteLimit('post', 7)).toBeNull();
    expect(await checkWriteLimit('comment', 7)).toBeNull();
    expect(calls).toEqual([
      { key: 'write:post:player:7', limit: WRITE_LIMITS.post.perHour, windowMs: HOUR_MS },
      { key: 'write:comment:player:7', limit: WRITE_LIMITS.comment.perHour, windowMs: HOUR_MS },
    ]);
  });

  it('넘으면 429 와 언제 다시 쓸 수 있는지', async () => {
    allowed = false;
    const res = await checkWriteLimit('post', 7);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBeTruthy();
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain(`글은 ${WRITE_LIMITS.post.perHour}개까지`);
    expect(body.error).toContain('뒤에 다시 써 주세요');
  });

  it('기본값은 사람이 손으로 쓰는 속도로는 닿지 않는다', () => {
    expect(WRITE_LIMITS.post.perHour).toBeGreaterThanOrEqual(10);
    expect(WRITE_LIMITS.comment.perHour).toBeGreaterThanOrEqual(30);
  });
});
