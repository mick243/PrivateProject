import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 운영 알림의 뒷일 — 기기 푸시(lib/ops-push.ts)와 받은 뒤의 흐름(lib/ops-alert-events.ts).
 *
 * web-push 는 대역입니다(실제 푸시 서버로 나가지 않음). 실제 암호화 · 전송은
 * 운영 서버에서 관리자 기기로 확인합니다 — deploy/ncp/README.md §9-4.
 */

type Sub = { id: number; endpoint: string; p256dh: string; auth: string; failures: number };
let subs: Sub[] = [];
const db: { fn: string; args: unknown }[] = [];
/** 주소별로 푸시 서버가 줄 답 — 숫자는 그 HTTP 상태로 실패 */
const answers = new Map<string, 'ok' | number>();
const sent: { endpoint: string; payload: string; options: Record<string, unknown> }[] = [];

vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('web-push')>();
  return {
    ...actual,
    sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string, options: Record<string, unknown>) => {
      sent.push({ endpoint: sub.endpoint, payload, options });
      const a = answers.get(sub.endpoint) ?? 'ok';
      if (a !== 'ok') throw new actual.WebPushError('실패', a, {}, '', sub.endpoint);
      return { statusCode: 201, body: '', headers: {} };
    }),
  };
});

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    ops_push_subscriptions: {
      findMany: async (args: unknown) => {
        db.push({ fn: 'findMany', args });
        return subs;
      },
      update: async (args: unknown) => void db.push({ fn: 'update', args }),
      deleteMany: async (args: unknown) => void db.push({ fn: 'deleteMany', args }),
    },
  }),
}));

const { sendOpsPush } = await import('@/lib/ops-push');

const env = { ...process.env };
const message = { title: '울려요 · 디스크', body: '본문', tag: 'ops-alert-12', url: '/?ops=open' };

beforeEach(() => {
  subs = [];
  db.length = 0;
  sent.length = 0;
  answers.clear();
  process.env.OPS_PUSH_PUBLIC_KEY = 'test-public-key'; // web-push 가 대역이라 모양은 보지 않습니다
  process.env.OPS_PUSH_PRIVATE_KEY = 'test-private-key';
  process.env.APP_URL = 'https://arcade.example.com';
});
afterEach(() => {
  process.env = { ...env };
});

describe('sendOpsPush', () => {
  it('키가 없으면 아무 데도 보내지 않는다 — 푸시만 꺼진다', async () => {
    delete process.env.OPS_PUSH_PRIVATE_KEY;
    subs = [{ id: 1, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a', failures: 0 }];
    expect(await sendOpsPush(message)).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sent).toEqual([]);
    expect(db).toEqual([]);
  });

  it('지금 관리자인 사람의 구독만 고른다', async () => {
    await sendOpsPush(message);
    expect(db[0]).toMatchObject({ fn: 'findMany', args: { where: { players: { is_admin: true } } } });
  });

  it('보낸 것은 성공 시각을, 버려진 구독(410)은 지우고, 그 밖의 실패는 센다 — 쌓이면 지운다', async () => {
    subs = [
      { id: 1, endpoint: 'https://fcm.googleapis.com/ok', p256dh: 'p', auth: 'a', failures: 2 },
      { id: 2, endpoint: 'https://fcm.googleapis.com/gone', p256dh: 'p', auth: 'a', failures: 0 },
      { id: 3, endpoint: 'https://fcm.googleapis.com/flaky', p256dh: 'p', auth: 'a', failures: 0 },
      { id: 4, endpoint: 'https://fcm.googleapis.com/dying', p256dh: 'p', auth: 'a', failures: 4 },
    ];
    answers.set('https://fcm.googleapis.com/gone', 410);
    answers.set('https://fcm.googleapis.com/flaky', 500);
    answers.set('https://fcm.googleapis.com/dying', 503);

    expect(await sendOpsPush(message)).toEqual({ sent: 1, failed: 3, removed: 2 });

    const by = (fn: string) => db.filter((d) => d.fn === fn).map((d) => d.args);
    expect(by('update')).toEqual(
      expect.arrayContaining([
        { where: { id: 1 }, data: { last_ok_at: expect.any(Date), failures: 0 } },
        { where: { id: 3 }, data: { failures: { increment: 1 } } },
      ]),
    );
    expect(by('deleteMany')).toEqual(expect.arrayContaining([{ where: { id: 2 } }, { where: { id: 4 } }]));
  });

  it('본문은 화면이 읽는 JSON 이고, 같은 알림끼리 덮어쓰는 topic · 서명 정보를 싣는다', async () => {
    subs = [{ id: 1, endpoint: 'https://fcm.googleapis.com/ok', p256dh: 'p', auth: 'a', failures: 0 }];
    await sendOpsPush(message);
    expect(JSON.parse(sent[0].payload)).toEqual(message);
    expect(sent[0].options).toMatchObject({
      topic: 'ops-alert-12',
      urgency: 'high',
      vapidDetails: { subject: 'https://arcade.example.com' },
    });
  });
});

describe('processAlertEvents — 받은 뒤의 흐름', () => {
  it('요약이 실패해도 푸시는 가고, 한꺼번에 많이 울리면 앞의 셋 + "그 밖에 N건" 으로 묶는다', async () => {
    vi.resetModules();
    const pushed: { title: string }[] = [];
    vi.doMock('@/lib/ops-alert-summary', () => ({
      summarizeAlert: vi.fn(async (id: number) => {
        if (id === 2) throw new Error('모델 오류');
      }),
    }));
    vi.doMock('@/lib/ops-alerts', () => ({
      getAlertView: vi.fn(async (id: number) => ({
        id,
        status: id > 5 ? 'resolved' : 'firing',
        alertname: `Rule${id}`,
        summary: null,
        startsAt: '2026-10-06T08:00:00Z',
        endsAt: id > 5 ? '2026-10-06T08:10:00Z' : null,
        ai: null,
      })),
    }));
    vi.doMock('@/lib/ops-push', () => ({
      sendOpsPush: vi.fn(async (m: { title: string }) => {
        pushed.push(m);
        return { sent: 1, failed: 0, removed: 0 };
      }),
    }));
    const { processAlertEvents } = await import('@/lib/ops-alert-events');

    await processAlertEvents({ fired: [1, 2, 3, 4], resolved: [6], repeated: 0 });
    expect(pushed.map((m) => m.title)).toEqual([
      '울려요 · Rule1',
      '울려요 · Rule2',
      '울려요 · Rule3',
      '그 밖에 2건이 더 있어요',
    ]);

    pushed.length = 0;
    await processAlertEvents({ fired: [1], resolved: [6], repeated: 0 });
    expect(pushed.map((m) => m.title)).toEqual(['울려요 · Rule1', '풀렸어요 · Rule6']);
    vi.doUnmock('@/lib/ops-alert-summary');
    vi.doUnmock('@/lib/ops-alerts');
    vi.doUnmock('@/lib/ops-push');
  });
});
