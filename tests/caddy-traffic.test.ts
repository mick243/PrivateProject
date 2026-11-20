import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LogTailer,
  TrafficWindow,
  classify,
  normalizePath,
  parseAccessLine,
  pushSamples,
  routeKey,
  summarize,
} from '@/scripts/caddy-traffic.mjs';

/**
 * Caddy 접근 로그를 읽어 요청 수 지표로 바꾸는 수집기 (scripts/caddy-traffic.mjs).
 *
 * Pulse 는 라벨이 없어 지표 이름이 곧 계약입니다 — 64자 · 점은 통계 구분자.
 * 이름 규칙이 흔들리면 대시보드 표가 조용히 깨지므로 그 부분을 가장 촘촘히 봅니다.
 */

/** Caddy 기본 JSON 인코더가 쓰는 모양 그대로 (공식 문서의 예시와 같은 필드) */
function line(o: {
  uri?: string;
  method?: string;
  status?: number;
  duration?: number;
  ua?: string | null;
  ts?: number;
}): string {
  const headers: Record<string, string[]> = { Accept: ['*/*'] };
  if (o.ua !== null) headers['User-Agent'] = [o.ua ?? 'Mozilla/5.0 (Windows NT 10.0) Chrome/130'];
  return JSON.stringify({
    level: 'info',
    ts: o.ts ?? 1_700_000_000.5,
    logger: 'http.log.access.log0',
    msg: 'handled request',
    request: {
      remote_ip: '203.0.113.9',
      proto: 'HTTP/2.0',
      method: o.method ?? 'GET',
      host: 'example.test',
      uri: o.uri ?? '/',
      headers,
    },
    bytes_read: 0,
    user_id: '',
    duration: o.duration ?? 0.012,
    size: 1234,
    status: o.status ?? 200,
    resp_headers: { Server: ['Caddy'] },
  });
}

const rec = (o: Parameters<typeof line>[0]) => parseAccessLine(line(o))!;

const NAME_RE_LAST = /\.(rpm|p95_ms|2xx|3xx|4xx|5xx|ok)$/;

describe('parseAccessLine', () => {
  it('Caddy 접근 로그 한 줄을 읽는다', () => {
    const r = rec({ uri: '/api/games?x=1', method: 'post', status: 201, duration: 0.25, ua: 'curl/8.0' });
    expect(r).toMatchObject({ method: 'POST', path: '/api/games', status: 201, ms: 250, ua: 'curl/8.0' });
    expect(r.ts).toBe(1_700_000_000_500);
  });

  it('쿼리스트링은 버린다 — 토큰이 섞여 있을 수 있다', () => {
    expect(rec({ uri: '/auth/verify?token=secret' }).path).toBe('/auth/verify');
  });

  it('접근 로그가 아닌 줄은 null', () => {
    expect(parseAccessLine('')).toBeNull();
    expect(parseAccessLine('not json')).toBeNull();
    expect(parseAccessLine('{broken')).toBeNull();
    expect(parseAccessLine(JSON.stringify({ level: 'error', msg: 'x' }))).toBeNull();
    expect(parseAccessLine(JSON.stringify({ request: { uri: '/' } }))).toBeNull(); // status 없음
  });

  it('프록시용 절대 URI 는 경로가 아니므로 한데 묶는다', () => {
    expect(rec({ uri: 'http://evil.test/x', method: 'GET', status: 400 }).path).toBe('(non-path)');
  });

  it('아주 긴 경로는 잘라 받는다', () => {
    expect(rec({ uri: '/' + 'a'.repeat(5000) }).path.length).toBeLessThanOrEqual(200);
  });

  it('User-Agent 가 없어도 죽지 않는다', () => {
    expect(rec({ ua: null }).ua).toBe('');
  });
});

describe('classify · routeKey', () => {
  it('종류를 가른다', () => {
    expect(classify(rec({ uri: '/api/arcades/12' }))).toBe('api');
    expect(classify(rec({ uri: '/_next/static/chunks/app.js' }))).toBe('static');
    expect(classify(rec({ uri: '/favicon.ico' }))).toBe('static');
    expect(classify(rec({ uri: '/fonts/a.woff2' }))).toBe('static');
    expect(classify(rec({ uri: '/finder' }))).toBe('page');
    expect(classify(rec({ uri: '/' }))).toBe('page');
  });

  it('404 는 경로가 뭐든 기타 — 스캐너 잡음이 페이지 수를 부풀리지 않는다', () => {
    expect(classify(rec({ uri: '/wp-login.php', status: 404 }))).toBe('other');
    expect(classify(rec({ uri: '/some-page', status: 404 }))).toBe('other');
  });

  it('api 의 404 는 api 로 남는다 (앱이 돌려준 정상 응답일 수 있다)', () => {
    expect(classify(rec({ uri: '/api/arcades/999', status: 404 }))).toBe('api');
  });

  it('숫자·UUID 를 [id] 로 접는다', () => {
    expect(routeKey(rec({ uri: '/api/arcades/12/reviews?x=1' }))).toBe('GET /api/arcades/[id]/reviews');
    expect(routeKey(rec({ uri: '/api/uploads/3f2b8c1e-1111-4222-8333-444455556666' }))).toBe('GET /api/uploads/[id]');
  });

  it('끝 슬래시와 점을 정리한다 — 점은 지표 이름의 통계 구분자라 들어가면 안 된다', () => {
    expect(routeKey(rec({ uri: '/finder/' }))).toBe('GET /finder');
    expect(normalizePath('/sitemap.xml')).toBe('/sitemap_xml');
  });

  it('404 는 전부 (404) 하나로 묶는다', () => {
    expect(routeKey(rec({ uri: '/wp-login.php', status: 404 }))).toBe('(404)');
    expect(routeKey(rec({ uri: '/api/whatever', status: 404 }))).toBe('(404)');
  });

  it('이상한 메서드는 (other) 로', () => {
    expect(routeKey(rec({ uri: '/x', method: 'PROPFIND', status: 405 }))).toBe('(other) /x');
  });
});

describe('TrafficWindow', () => {
  it('건수 · 분당 · 상태 · 종류 · 봇을 센다', () => {
    const w = new TrafficWindow(0);
    for (let i = 0; i < 6; i += 1) w.add(rec({ uri: '/finder' }));
    for (let i = 0; i < 4; i += 1) w.add(rec({ uri: '/api/arcades', duration: 0.1 }));
    for (let i = 0; i < 3; i += 1) w.add(rec({ uri: '/_next/static/a.js' }));
    w.add(rec({ uri: '/api/chat', status: 502, duration: 1 }));
    w.add(rec({ uri: '/wp-login.php', status: 404, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }));
    w.add(rec({ uri: '/old', status: 301 }));

    const s = w.stats(30_000);
    expect(s.total).toBe(16);
    expect(s.rpm).toBeCloseTo(32, 5); // 16건 / 30초
    expect(s.status).toEqual({ '2xx': 13, '3xx': 1, '4xx': 1, '5xx': 1 });
    expect(s.kinds).toEqual({ page: 6 + 1, api: 5, static: 3, other: 1 });
    expect(s.bots).toBe(1);
    expect(s.p95Ms).toBeGreaterThan(0);
  });

  it('경로별은 정적 파일을 빼고 센다', () => {
    const w = new TrafficWindow(0);
    w.add(rec({ uri: '/_next/static/a.js' }));
    w.add(rec({ uri: '/finder' }));
    w.add(rec({ uri: '/finder' }));
    w.add(rec({ uri: '/api/chat', status: 500 }));
    const keys = w.stats(60_000).routes;
    expect(keys.map((r: { key: string }) => r.key)).toEqual(['GET /finder', 'GET /api/chat']);
    expect(keys.find((r: { key: string }) => r.key === 'GET /api/chat')?.errors).toBe(1);
  });

  it('요청이 0건이어도 기본 지표를 전부 낸다 — 조용한 것과 죽은 것을 가르려고', () => {
    const w = new TrafficWindow(0);
    const { samples } = w.snapshot(30_000);
    const names = samples.map((s: { metric: string }) => s.metric);
    expect(names).toEqual(
      expect.arrayContaining([
        'edge.req.rpm',
        'edge.req.2xx',
        'edge.req.3xx',
        'edge.req.4xx',
        'edge.req.5xx',
        'edge.req.p95_ms',
        'edge.kind.page.rpm',
        'edge.kind.api.rpm',
        'edge.kind.static.rpm',
        'edge.kind.other.rpm',
        'edge.bot.rpm',
        'edge.log.ok',
      ]),
    );
    expect(samples.every((s: { value: number }) => s.value === 0 || s.value === 1)).toBe(true);
  });

  it('edge.log.ok 는 로그를 못 읽을 때 0', () => {
    const w = new TrafficWindow(0);
    const ok = (logOk: boolean) =>
      w.snapshot(1000, { logOk }).samples.find((s: { metric: string }) => s.metric === 'edge.log.ok').value;
    expect(ok(true)).toBe(1);
    expect(ok(false)).toBe(0);
  });

  it('snapshot 은 창을 비운다', () => {
    const w = new TrafficWindow(0);
    w.add(rec({}));
    expect(w.snapshot(30_000).stats.total).toBe(1);
    expect(w.snapshot(60_000).stats.total).toBe(0);
  });

  it('모든 지표 이름이 Pulse 규약 안이다 — 64자 이하 · 마지막 점 뒤가 통계 이름 · 키에 점 없음', () => {
    const w = new TrafficWindow(0);
    // 스캐너와 긴 경로, 점이 든 경로, 종류가 폭발하는 경로
    w.add(rec({ uri: '/community/' + 'x'.repeat(150), status: 200 }));
    w.add(rec({ uri: '/a.b.c/d.e', status: 200 }));
    for (let i = 0; i < 400; i += 1) w.add(rec({ uri: `/p/slug-${i}-abc`, status: 200 }));
    for (let i = 0; i < 400; i += 1) w.add(rec({ uri: `/probe-${i}.php`, status: 404 }));

    const { samples } = w.snapshot(30_000);
    expect(samples.length).toBeLessThanOrEqual(2000); // Pulse 수집 API 의 한 번 상한
    for (const s of samples) {
      expect(s.metric.length).toBeLessThanOrEqual(64);
      expect(s.metric).toMatch(NAME_RE_LAST);
      expect(Number.isFinite(s.value)).toBe(true);
      if (s.metric.startsWith('edge.route.')) {
        const key = s.metric.slice('edge.route.'.length, s.metric.lastIndexOf('.'));
        expect(key).not.toContain('.');
      }
    }
    // 같은 이름이 두 번 실리지 않는다
    expect(new Set(samples.map((s: { metric: string }) => s.metric)).size).toBe(samples.length);
  });

  it('경로 종류가 상한을 넘으면 (other) 로 묶인다 — 404 스캐너는 (404) 하나', () => {
    const w = new TrafficWindow(0);
    for (let i = 0; i < 400; i += 1) w.add(rec({ uri: `/p/slug-${i}-abc` }));
    for (let i = 0; i < 400; i += 1) w.add(rec({ uri: `/probe-${i}.php`, status: 404 }));
    const keys = w.stats(60_000).routes.map((r: { key: string }) => r.key);
    // 실제 경로 150 + 묶음 버킷 2 — (404) 는 실제 경로가 상한을 채운 뒤에 처음 나와도 밀려나지 않는다
    expect(keys.length).toBeLessThanOrEqual(152);
    expect(keys).toContain('(other)');
    expect(keys).toContain('(404)');
    expect(keys.filter((k: string) => k.startsWith('GET /probe')).length).toBe(0);
  });
});

describe('LogTailer', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-traffic-'));
    file = path.join(dir, 'access.log');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('처음에는 파일 끝에서 시작해 과거 로그를 읽지 않는다', () => {
    fs.writeFileSync(file, 'old1\nold2\n');
    const t = new LogTailer(file);
    expect(t.poll()).toEqual([]);
    fs.appendFileSync(file, 'new1\n');
    expect(t.poll()).toEqual(['new1']);
  });

  it('fromStart 면 처음부터 읽는다', () => {
    fs.writeFileSync(file, 'a\nb\n');
    expect(new LogTailer(file, { fromStart: true }).poll()).toEqual(['a', 'b']);
  });

  it('줄이 덜 써진 채로 읽혀도 완성될 때까지 기다린다', () => {
    const t = new LogTailer(file, { fromStart: true });
    fs.writeFileSync(file, 'one\ntw');
    expect(t.poll()).toEqual(['one']);
    fs.appendFileSync(file, 'o\nthree\n');
    expect(t.poll()).toEqual(['two', 'three']);
  });

  it('한글이 읽기 경계에서 쪼개져도 깨지지 않는다', () => {
    const t = new LogTailer(file, { fromStart: true });
    const bytes = Buffer.from('가나다\n', 'utf8');
    fs.writeFileSync(file, bytes.subarray(0, 4)); // '가' + '나' 의 첫 바이트
    expect(t.poll()).toEqual([]);
    fs.appendFileSync(file, bytes.subarray(4));
    expect(t.poll()).toEqual(['가나다']);
  });

  it('회전(파일이 바뀜)을 알아채고 새 파일을 처음부터 읽는다', () => {
    const t = new LogTailer(file, { fromStart: true });
    fs.writeFileSync(file, 'a\nb\n');
    expect(t.poll()).toEqual(['a', 'b']);
    // Caddy(lumberjack)는 옛 파일을 이름만 바꿔 두고 같은 이름의 새 파일을 만든다
    fs.renameSync(file, path.join(dir, 'access-2026.log'));
    fs.writeFileSync(file, 'c\n');
    expect(t.poll()).toEqual(['c']);
  });

  it('잘림(크기가 줄어듦)도 새로 시작한 것으로 본다', () => {
    const t = new LogTailer(file, { fromStart: true });
    fs.writeFileSync(file, 'aaaaaaaa\nbbbbbbbb\n');
    t.poll();
    fs.writeFileSync(file, 'c\n');
    expect(t.poll()).toEqual(['c']);
  });

  it('파일이 없으면 ok=false 로 기다리다 생기면 읽는다 — 죽지 않는다', () => {
    const t = new LogTailer(file, { fromStart: true });
    expect(t.poll()).toEqual([]);
    expect(t.ok).toBe(false);
    expect(t.error).not.toBe('');
    fs.writeFileSync(file, 'x\n');
    expect(t.poll()).toEqual(['x']);
    expect(t.ok).toBe(true);
  });
});

describe('pushSamples', () => {
  const samples = [{ ts: '2026-09-30T00:00:00.000Z', metric: 'edge.req.rpm', value: 12 }];
  const opts = { apiUrl: 'http://pulse.test/', key: 'pk_test', agentId: 'arcade-finder-edge' };

  it('Pulse 수집 API 로 앱 계측과 같은 모양으로 보낸다', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;

    expect(await pushSamples(samples, { ...opts, fetchImpl, now: Date.parse('2026-09-30T00:00:30Z') })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://pulse.test/api/v1/metrics');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer pk_test');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ agentId: 'arcade-finder-edge', sentAt: '2026-09-30T00:00:30.000Z', samples });
  });

  it('2000개를 넘으면 나눠 보낸다 — Pulse 는 한 번에 2000개까지 받는다', async () => {
    const many = Array.from({ length: 4500 }, (_, i) => ({ ts: samples[0].ts, metric: `edge.route.r${i}.rpm`, value: 1 }));
    const sizes: number[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sizes.push(JSON.parse(String(init.body)).samples.length);
      return { ok: true, status: 202 } as Response;
    }) as unknown as typeof fetch;
    await pushSamples(many, { ...opts, fetchImpl });
    expect(sizes).toEqual([2000, 2000, 500]);
  });

  it('Pulse 가 거절하거나 죽어도 던지지 않고 false', async () => {
    const reject = (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await pushSamples(samples, { ...opts, fetchImpl: reject })).toBe(false);
    expect(await pushSamples(samples, { ...opts, fetchImpl: boom })).toBe(false);
  });
});

describe('summarize', () => {
  it('로그 파일 전체를 표로 요약한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-traffic-sum-'));
    const f = path.join(dir, 'a.log');
    const t0 = 1_700_000_000;
    const lines = [
      line({ uri: '/finder', ts: t0 }),
      line({ uri: '/finder', ts: t0 + 10 }),
      line({ uri: '/api/chat', status: 502, ts: t0 + 70 }),
      line({ uri: '/wp-login.php', status: 404, ts: t0 + 80, ua: 'python-requests/2.0' }),
      'garbage line',
    ];
    fs.writeFileSync(f, lines.join('\n') + '\n');
    try {
      const out = summarize([f]);
      expect(out).toContain('요청   4건');
      expect(out).toContain('5xx 1');
      expect(out).toContain('GET /finder');
      expect(out).toContain('← 5xx 1');
      expect(out).toContain('접근 로그가 아닌 줄 1개');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('요청이 없으면 그렇게 말한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-traffic-sum-'));
    const f = path.join(dir, 'empty.log');
    fs.writeFileSync(f, '');
    try {
      expect(summarize([f])).toContain('요청이 없습니다');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
