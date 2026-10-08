import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-types';

/**
 * 운영 알림 라우트 — **누가 부르는가**(웹훅 토큰 · 관리자)와 받은 뒤 할 일을 미루는지.
 *
 * DB(lib/ops-alerts · lib/ops-push)와 요약 · 푸시(lib/ops-alert-events)는 대역입니다.
 * after() 는 요청 밖에서 부르면 던지므로, 넘긴 일을 모아 두는 대역으로 바꿉니다.
 */

const calls: { fn: string; args: unknown[] }[] = [];
const afterQueue: (() => unknown)[] = [];
let isAdmin = false;
let recordResult = { fired: [1], resolved: [], repeated: 0, dismissed: 0 };

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (fn: () => unknown) => void afterQueue.push(fn) };
});

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    players: { findUnique: async () => ({ nickname: '관리자', is_admin: isAdmin, token_epoch: 0 }) },
  }),
}));

vi.mock('@/lib/ops-alerts', () => ({
  recordAlerts: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'record', args });
    return recordResult;
  }),
  listAlerts: vi.fn(async () => {
    calls.push({ fn: 'list', args: [] });
    return { alerts: [], unread: 0 };
  }),
  markAllAlertsRead: vi.fn(async () => {
    calls.push({ fn: 'read', args: [] });
    return 2;
  }),
  dismissAlert: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: 'dismiss', args });
    return 1;
  }),
  dismissResolvedAlerts: vi.fn(async () => {
    calls.push({ fn: 'dismissResolved', args: [] });
    return 3;
  }),
}));

vi.mock('@/lib/ops-alert-events', () => ({
  processAlertEvents: vi.fn(async (...args: unknown[]) => void calls.push({ fn: 'events', args })),
}));

vi.mock('@/lib/ops-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-push')>();
  return {
    ...actual,
    savePushSubscription: vi.fn(async (...args: unknown[]) => void calls.push({ fn: 'save', args })),
    deletePushSubscription: vi.fn(async (...args: unknown[]) => void calls.push({ fn: 'delete', args })),
    countAdminSubscriptions: vi.fn(async () => 1),
  };
});

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  consume: vi.fn(async () => ({ allowed: true, count: 1, limit: 10, retryAfterMs: 0 })),
}));

const alertsRoute = await import('@/app/api/ops/alerts/route');
const readRoute = await import('@/app/api/ops/alerts/read/route');
const testRoute = await import('@/app/api/ops/alerts/test/route');
const pushRoute = await import('@/app/api/ops/push/route');

const URL_BASE = 'http://localhost';
const env = { ...process.env };

function webhook(body: unknown, token?: string): Request {
  return new Request(`${URL_BASE}/api/ops/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function as(admin: boolean, path: string, init?: RequestInit): Request {
  isAdmin = admin;
  return new Request(`${URL_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie: `${SESSION_COOKIE}=${createSessionToken(7, 0)}` },
  });
}

const alert = {
  status: 'firing',
  labels: { alertname: 'DiskLow', severity: 'warning' },
  annotations: { summary: '디스크 여유가 15% 아래입니다' },
  startsAt: '2026-10-06T08:20:50Z',
  endsAt: '0001-01-01T00:00:00Z',
  fingerprint: 'abc123',
  values: { A: 0.14 },
};

beforeEach(() => {
  calls.length = 0;
  afterQueue.length = 0;
  isAdmin = false;
  recordResult = { fired: [1], resolved: [], repeated: 0, dismissed: 0 };
  process.env.OPS_ALERT_TOKEN = 'grafana-secret';
  delete process.env.OPS_PUSH_PUBLIC_KEY;
  delete process.env.OPS_PUSH_PRIVATE_KEY;
});
afterEach(() => {
  process.env = { ...env };
});

describe('POST /api/ops/alerts — Grafana 웹훅', () => {
  it('토큰이 설정되지 않은 서버에서는 경로가 없는 것처럼 404', async () => {
    delete process.env.OPS_ALERT_TOKEN;
    const res = await alertsRoute.POST(webhook({ alerts: [alert] }, 'grafana-secret'));
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('토큰이 없거나 틀리면 401 + www-authenticate, 아무것도 적지 않는다', async () => {
    for (const token of [undefined, 'wrong']) {
      const res = await alertsRoute.POST(webhook({ alerts: [alert] }, token));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(calls).toEqual([]);
  });

  it('Grafana 모양이 아니면 400', async () => {
    const res = await alertsRoute.POST(webhook({ hello: 'world' }, 'grafana-secret'));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('받으면 바로 적고 응답한다 — 요약 · 푸시는 응답 뒤(after)로 미룬다', async () => {
    const res = await alertsRoute.POST(webhook({ receiver: 'empty', alerts: [alert] }, 'grafana-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, fired: 1, resolved: 0, repeated: 0, dismissed: 0 });

    const [record] = calls;
    expect(record.fn).toBe('record');
    const [inputs] = record.args as [{ fingerprint: string; endsAt: Date | null; alertname: string }[]];
    expect(inputs[0]).toMatchObject({ fingerprint: 'abc123', alertname: 'DiskLow', endsAt: null });

    // 아직 요약 · 푸시는 하지 않았다
    expect(calls.map((c) => c.fn)).toEqual(['record']);
    expect(afterQueue).toHaveLength(1);
    await afterQueue[0]();
    expect(calls.map((c) => c.fn)).toEqual(['record', 'events']);
  });

  it('같은 상태를 다시 보낸 것뿐이면(몇 시간마다 오는 반복) 할 일을 미루지 않는다', async () => {
    recordResult = { fired: [], resolved: [], repeated: 1, dismissed: 0 };
    const res = await alertsRoute.POST(webhook({ alerts: [alert] }, 'grafana-secret'));
    expect(res.status).toBe(200);
    expect(afterQueue).toHaveLength(0);
  });

  it('관리자가 지운 사건이 풀린 것뿐이면 할 일을 미루지 않는다 — 푸시하지 않음', async () => {
    recordResult = { fired: [], resolved: [], repeated: 0, dismissed: 1 };
    const res = await alertsRoute.POST(webhook({ alerts: [{ ...alert, status: 'resolved' }] }, 'grafana-secret'));
    expect(res.status).toBe(200);
    expect((await res.json()).dismissed).toBe(1);
    expect(afterQueue).toHaveLength(0);
  });
});

describe('DELETE /api/ops/alerts — 목록에서 지우기', () => {
  const del = (admin: boolean, query: string) => alertsRoute.DELETE(as(admin, `/api/ops/alerts${query}`, { method: 'DELETE' }));

  it('비로그인은 401, 일반 사용자는 403 — 지우지 않는다', async () => {
    expect((await alertsRoute.DELETE(new Request(`${URL_BASE}/api/ops/alerts?id=1`, { method: 'DELETE' }))).status).toBe(401);
    expect((await del(false, '?id=1')).status).toBe(403);
    expect((await del(false, '?status=resolved')).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('?id= 하나를 지운다', async () => {
    const res = await del(true, '?id=12');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: 1 });
    expect(calls).toEqual([{ fn: 'dismiss', args: [12] }]);
  });

  it('?status=resolved 는 풀린 것 전부', async () => {
    const res = await del(true, '?status=resolved');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: 3 });
    expect(calls).toEqual([{ fn: 'dismissResolved', args: [] }]);
  });

  it('무엇을 지울지 모호하면 400 — 아무것도 지우지 않는다', async () => {
    for (const q of ['', '?id=abc', '?id=0', '?id=-3', '?id=1.5', '?status=firing', '?status=', '?id=1&status=resolved']) {
      expect((await del(true, q)).status, q).toBe(400);
    }
    expect(calls).toEqual([]);
  });
});

describe('관리자 전용 — 목록 · 읽음 · 시험 알림', () => {
  it('비로그인은 401, 일반 사용자는 403 — DB 를 묻지 않는다', async () => {
    expect((await alertsRoute.GET(new Request(`${URL_BASE}/api/ops/alerts`))).status).toBe(401);
    expect((await alertsRoute.GET(as(false, '/api/ops/alerts'))).status).toBe(403);
    expect((await readRoute.PUT(as(false, '/api/ops/alerts/read', { method: 'PUT' }))).status).toBe(403);
    expect((await testRoute.POST(as(false, '/api/ops/alerts/test', { method: 'POST' }))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('관리자 목록은 푸시 키가 있는지도 알려 준다', async () => {
    let res = await alertsRoute.GET(as(true, '/api/ops/alerts'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alerts: [], unread: 0, pushReady: false });

    process.env.OPS_PUSH_PUBLIC_KEY = 'pub';
    process.env.OPS_PUSH_PRIVATE_KEY = 'priv';
    res = await alertsRoute.GET(as(true, '/api/ops/alerts'));
    expect((await res.json()).pushReady).toBe(true);
  });

  it('읽음은 PUT — 원하는 상태를 받는다', async () => {
    const res = await readRoute.PUT(as(true, '/api/ops/alerts/read', { method: 'PUT' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
  });

  it('시험 알림은 같은 길(적기 → after 로 요약 · 푸시)을 탄다', async () => {
    const res = await testRoute.POST(as(true, '/api/ops/alerts/test', { method: 'POST' }));
    expect(res.status).toBe(202);
    const [inputs] = calls[0].args as [{ alertname: string; status: string }[]];
    expect(inputs[0]).toMatchObject({ alertname: 'TestAlert', status: 'firing' });
    expect(afterQueue).toHaveLength(1);
  });
});

describe('/api/ops/push — 이 기기 알림', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPa', auth: 'k' } };
  const put = (body: unknown) =>
    as(true, '/api/ops/push', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('서버에 키가 없으면 503 — 켤 수 없다고 알린다', async () => {
    expect((await pushRoute.GET(as(true, '/api/ops/push'))).status).toBe(503);
    expect((await pushRoute.PUT(put(sub))).status).toBe(503);
  });

  it('키가 있으면 공개 키를 주고, 구독은 세션 주인 이름으로 저장한다', async () => {
    process.env.OPS_PUSH_PUBLIC_KEY = 'pub';
    process.env.OPS_PUSH_PRIVATE_KEY = 'priv';
    const key = await pushRoute.GET(as(true, '/api/ops/push'));
    expect(await key.json()).toEqual({ publicKey: 'pub', devices: 1 });

    const res = await pushRoute.PUT(put(sub));
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'save', args: [7, sub, null] });
  });

  it('푸시 서버가 아닌 주소는 400 — 서버가 아무 주소로나 요청을 보내지 않게', async () => {
    process.env.OPS_PUSH_PUBLIC_KEY = 'pub';
    process.env.OPS_PUSH_PRIVATE_KEY = 'priv';
    const res = await pushRoute.PUT(put({ ...sub, endpoint: 'https://internal.example/hook' }));
    expect(res.status).toBe(400);
    expect(calls.filter((c) => c.fn === 'save')).toEqual([]);
  });

  it('끄기는 DELETE ?endpoint= — 본문 없이', async () => {
    expect((await pushRoute.DELETE(as(true, '/api/ops/push', { method: 'DELETE' }))).status).toBe(400);
    const res = await pushRoute.DELETE(
      as(true, `/api/ops/push?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ fn: 'delete', args: [7, sub.endpoint] });
  });

  it('일반 사용자는 구독할 수 없다', async () => {
    process.env.OPS_PUSH_PUBLIC_KEY = 'pub';
    process.env.OPS_PUSH_PRIVATE_KEY = 'priv';
    isAdmin = false;
    const req = new Request(`${URL_BASE}/api/ops/push`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${createSessionToken(7, 0)}` },
      body: JSON.stringify(sub),
    });
    expect((await pushRoute.PUT(req)).status).toBe(403);
  });
});
