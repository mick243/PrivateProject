import { describe, expect, it, vi } from 'vitest';
import {
  badId,
  badJson,
  fail,
  handle,
  invalid,
  needLogin,
  notFound,
  parseId,
  readJson,
} from '@/lib/api-errors';
import { arcadeInputSchema } from '@/lib/validation';

/**
 * 에러 응답의 **계약**을 봅니다. 클라이언트가 전부 이렇게 쓰기 때문입니다.
 *
 *   const data = await res.json();
 *   if (!res.ok) setError(data.error ?? '기본 문구');
 *
 * 그래서 실패 응답은 어떤 경로로 나가도 **JSON 이어야 하고 `error` 키가 있어야**
 * 합니다. 본문 없는 500 이면 `res.json()` 이 먼저 던져서 저 기본 문구조차 못 씁니다.
 */

const req = (url = 'http://localhost/api/x', init?: RequestInit) => new Request(url, init);

describe('parseId', () => {
  it('양의 정수만 통과한다', () => {
    expect(parseId('7')).toBe(7);
    expect(parseId(7)).toBe(7);
  });

  it('0·음수·소수·빈값·문자는 거른다', () => {
    for (const v of ['0', '-1', '1.5', '', ' ', 'abc', null, undefined, NaN]) {
      expect(parseId(v)).toBeNull();
    }
  });

  it('큰 값이 정수 범위를 벗어나면 거른다', () => {
    // 예전에는 라우트마다 따로 구현돼 있어 여기서 갈릴 수 있었습니다.
    expect(parseId('1e999')).toBeNull();
  });
});

describe('표준 실패 응답', () => {
  it('전부 JSON 이고 error 키가 있다', async () => {
    const cases: [Response, number][] = [
      [badId(), 400],
      [badJson(), 400],
      [needLogin(), 401],
      [notFound('오락실을 찾을 수 없습니다'), 404],
      [fail(409, '이미 있습니다'), 409],
    ];
    for (const [res, status] of cases) {
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error?: unknown };
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toBe('');
    }
  });

  it('zod 실패는 details 배열을 함께 준다 — 화면이 그걸 먼저 본다', async () => {
    const parsed = arcadeInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const res = invalid(parsed.error);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toBe('입력값이 올바르지 않습니다');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('details 가 없으면 키 자체를 넣지 않는다', async () => {
    const body = (await fail(400, '그냥 실패').json()) as Record<string, unknown>;
    expect('details' in body).toBe(false);
  });
});

describe('readJson', () => {
  it('정상 본문은 값으로 준다', async () => {
    const r = req('http://localhost/api/x', { method: 'POST', body: '{"a":1}' });
    const parsed = await readJson(r);
    expect(parsed).toEqual({ ok: true, value: { a: 1 } });
  });

  it('깨진 본문은 400 응답으로 준다 — 던지지 않는다', async () => {
    const r = req('http://localhost/api/x', { method: 'POST', body: '{oops' });
    const parsed = await readJson(r);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(400);
  });
});

describe('handle — 빠져나온 예외를 JSON 500 으로', () => {
  it('정상 응답은 그대로 통과시킨다', async () => {
    const wrapped = handle(async () => Response.json({ ok: true }));
    const res = await wrapped(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('던진 예외가 JSON 500 이 된다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = handle(async () => {
      throw new Error('DB 가 끊겼습니다');
    });

    const res = await wrapped(req());
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    // 내부 사정이 화면으로 나가면 안 됩니다 — 원인은 로그로만.
    expect(body.error).not.toContain('DB 가 끊겼습니다');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('메서드와 경로를 로그에 남긴다 — 어디서 터졌는지 알아야 한다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = handle(async () => {
      throw new Error('boom');
    });

    await wrapped(req('http://localhost/api/posts/7', { method: 'DELETE' }));
    expect(spy.mock.calls[0]?.[0]).toContain('DELETE /api/posts/7');
    spy.mockRestore();
  });

  it('Next 의 제어 흐름 예외(redirect·notFound)는 삼키지 않는다', async () => {
    // 삼키면 리다이렉트가 500 이 됩니다.
    const signal = Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT;replace;/x;307;' });
    const wrapped = handle(async () => {
      throw signal;
    });
    await expect(wrapped(req())).rejects.toBe(signal);
  });

  it('ctx(두 번째 인자)를 그대로 넘긴다', async () => {
    const wrapped = handle(async (_r: Request, ctx: { params: Promise<{ id: string }> }) =>
      Response.json({ id: (await ctx.params).id }),
    );
    const res = await wrapped(req(), { params: Promise.resolve({ id: '42' }) });
    expect(await res.json()).toEqual({ id: '42' });
  });
});
