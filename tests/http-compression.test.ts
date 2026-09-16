import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { json } from '@/lib/http';

/**
 * API 응답 압축 — 지키려는 계약은 **"본문이 달라지지 않는다"** 하나입니다.
 *
 * Next 는 라우트 핸들러의 JSON 을 압축해 주지 않아서 이 계층을 직접 넣었는데
 * (lib/http.ts), 압축은 조용히 틀리는 종류의 최적화입니다 — 헤더만 붙고 본문은
 * 안 눌렸거나, 눌렸는데 헤더가 없거나, Vary 가 빠져 캐시가 엉뚱한 걸 주거나.
 * 그래서 "압축됐다" 가 아니라 **풀면 원본과 같은가**를 봅니다.
 */

const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `arcade-${i}`, tag: 'x'.repeat(40) })) };
const small = { ok: true };

const req = (accept?: string) =>
  new Request('http://localhost/api/test', accept ? { headers: { 'accept-encoding': accept } } : undefined);

afterEach(() => {
  delete process.env.API_COMPRESSION;
});

describe('json() 응답 압축', () => {
  it('gzip 을 받아 주면 gzip 으로 내려가고, 풀면 원본과 같다', async () => {
    const res = await json(req('gzip, deflate'), big);

    expect(res.headers.get('Content-Encoding')).toBe('gzip');
    expect(res.headers.get('Content-Type')).toBe('application/json');

    const packed = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(gunzipSync(packed).toString('utf8'))).toEqual(big);
  });

  it('brotli 를 받아 주면 gzip 보다 brotli 를 고른다', async () => {
    const res = await json(req('gzip, br'), big);

    expect(res.headers.get('Content-Encoding')).toBe('br');
    const packed = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(brotliDecompressSync(packed).toString('utf8'))).toEqual(big);
  });

  it('실제로 작아진다 — 헤더만 붙고 본문이 그대로면 의미가 없다', async () => {
    const raw = Buffer.byteLength(JSON.stringify(big), 'utf8');
    const res = await json(req('br'), big);

    expect(Number(res.headers.get('Content-Length'))).toBeLessThan(raw / 2);
  });

  it('Accept-Encoding 이 없으면 압축하지 않고 평문 JSON 을 준다', async () => {
    const res = await json(req(), big);

    expect(res.headers.get('Content-Encoding')).toBeNull();
    expect(await res.json()).toEqual(big);
  });

  it('작은 응답은 압축하지 않는다 — 왕복이 안 줄고 CPU 만 든다', async () => {
    const res = await json(req('br, gzip'), small);

    expect(res.headers.get('Content-Encoding')).toBeNull();
    expect(await res.json()).toEqual(small);
  });

  it('압축 여부와 무관하게 Vary: Accept-Encoding 을 붙인다', async () => {
    // 이게 빠지면 중간 캐시가 gzip 본문을 압축 모르는 클라이언트에게 줍니다.
    for (const accept of ['br', 'gzip', undefined]) {
      const res = await json(req(accept), big);
      expect(res.headers.get('Vary')).toBe('Accept-Encoding');
    }
  });

  it('상태코드와 추가 헤더는 그대로 실려 간다', async () => {
    const res = await json(req('br'), big, { status: 201, headers: { 'X-Total': '200' } });

    expect(res.status).toBe(201);
    expect(res.headers.get('X-Total')).toBe('200');
    expect(res.headers.get('Content-Encoding')).toBe('br');
  });

  it('API_COMPRESSION=off 면 앞단 프록시에 맡기고 손대지 않는다', async () => {
    process.env.API_COMPRESSION = 'off';
    const res = await json(req('br, gzip'), big);

    expect(res.headers.get('Content-Encoding')).toBeNull();
    expect(await res.json()).toEqual(big);
  });

  it('Content-Length 가 실제 본문 길이와 맞는다', async () => {
    const res = await json(req('gzip'), big);
    const packed = Buffer.from(await res.arrayBuffer());

    expect(Number(res.headers.get('Content-Length'))).toBe(packed.byteLength);
  });
});


/**
 * 참조 데이터 캐시 — 압축이 바이트를 줄인다면 이쪽은 **왕복 자체를 없앱니다.**
 * 기종 마스터·말머리처럼 마이그레이션으로만 바뀌는 값에만 붙습니다.
 */
describe('ETag · 조건부 요청', () => {
  const cached = { headers: { 'Cache-Control': 'private, max-age=300' } };

  it('Cache-Control 이 있는 응답에만 ETag 를 붙인다', async () => {
    const withCache = await json(new Request('http://x/'), { a: 1 }, cached);
    expect(withCache.headers.get('ETag')).toMatch(/^W\/"/);

    const without = await json(new Request('http://x/'), { a: 1 });
    expect(without.headers.get('ETag')).toBeNull();
  });

  it('같은 내용이면 같은 ETag, 다른 내용이면 다른 ETag', async () => {
    const one = await json(new Request('http://x/'), { a: 1 }, cached);
    const same = await json(new Request('http://x/'), { a: 1 }, cached);
    const other = await json(new Request('http://x/'), { a: 2 }, cached);
    expect(same.headers.get('ETag')).toBe(one.headers.get('ETag'));
    expect(other.headers.get('ETag')).not.toBe(one.headers.get('ETag'));
  });

  it('If-None-Match 가 맞으면 본문 없이 304 를 준다', async () => {
    const first = await json(new Request('http://x/'), { a: 1 }, cached);
    const etag = first.headers.get('ETag')!;

    const second = await json(
      new Request('http://x/', { headers: { 'if-none-match': etag } }),
      { a: 1 },
      cached,
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    // 본문이 없으므로 길이·인코딩 헤더가 남아 있으면 안 된다
    expect(second.headers.get('Content-Length')).toBeNull();
    expect(second.headers.get('Content-Encoding')).toBeNull();
  });

  it('ETag 가 다르면 평소대로 200 과 본문을 준다', async () => {
    const res = await json(
      // HTTP 헤더는 ASCII 만 담을 수 있어 한글을 값으로 쓰지 않는다
      new Request('http://x/', { headers: { 'if-none-match': 'W/"stale"' } }),
      { a: 1 },
      cached,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });
});
