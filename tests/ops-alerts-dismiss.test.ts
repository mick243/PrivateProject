import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsAlertInput } from '@/lib/ops-alert-input';

/**
 * 운영 알림 지우기 (db/migrate-082) — 지운 사건은 같은 사건의 반복 · 풀림이 와도 다시 뜨지 않고
 * 알리지도 않으며, 같은 규칙이 **새로** 울리면 다시 뜬다.
 *
 * lib/ops-alerts.ts 가 쓰는 Prisma 호출만 흉내 내는 메모리 표로 돌립니다 (DB 없이).
 */

type Row = {
  id: number;
  fingerprint: string;
  starts_at: Date;
  status: string;
  alertname: string;
  severity: string | null;
  summary: string | null;
  labels: unknown;
  eval_values: unknown;
  generator_url: string | null;
  ends_at: Date | null;
  ai_summary: unknown;
  ai_error: string | null;
  received_at: Date;
  updated_at: Date;
  read_at: Date | null;
  dismissed_at: Date | null;
};

let rows: Row[] = [];
let nextId = 1;

/** where 의 키마다: null 은 IS NULL, { lt } 는 미만, 나머지는 같음 */
function matches(r: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cell = (r as Record<string, unknown>)[k];
    if (v === null) return cell === null;
    if (v && typeof v === 'object' && 'lt' in v) return (cell as Date) < (v as { lt: Date }).lt;
    if (v instanceof Date) return (cell as Date).getTime() === v.getTime();
    return cell === v;
  });
}

function findByWhere(where: Record<string, unknown>): Row | undefined {
  const key = where.fingerprint_starts_at as { fingerprint: string; starts_at: Date } | undefined;
  if (key) return rows.find((r) => r.fingerprint === key.fingerprint && r.starts_at.getTime() === key.starts_at.getTime());
  return rows.find((r) => matches(r, where));
}

const ops_alerts = {
  findUnique: async ({ where }: { where: Record<string, unknown> }) => findByWhere(where) ?? null,
  create: async ({ data }: { data: Partial<Row> }) => {
    const now = new Date();
    const row = {
      id: nextId++,
      severity: null,
      summary: null,
      labels: {},
      eval_values: null,
      generator_url: null,
      ends_at: null,
      ai_summary: null,
      ai_error: null,
      received_at: now,
      updated_at: now,
      read_at: null,
      dismissed_at: null,
      ...data,
    } as Row;
    rows.push(row);
    return row;
  },
  update: async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
    const row = rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return row;
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    const hit = rows.filter((r) => matches(r, where));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  },
  deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
    const before = rows.length;
    rows = rows.filter((r) => !matches(r, where));
    return { count: before - rows.length };
  },
  findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number }) =>
    rows
      .filter((r) => matches(r, where))
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.id - a.id)
      .slice(0, take),
  count: async ({ where }: { where?: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length,
};

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({ ops_alerts }),
  iso: (v: Date) => v.toISOString(),
}));

const { dismissAlert, dismissResolvedAlerts, listAlerts, markAllAlertsRead, recordAlerts } = await import(
  '@/lib/ops-alerts'
);

function input(over: Partial<OpsAlertInput> = {}): OpsAlertInput {
  return {
    fingerprint: 'disk',
    startsAt: new Date('2026-10-08T01:00:00Z'),
    status: 'firing',
    alertname: 'DiskLow',
    severity: 'warning',
    summary: '디스크 여유가 15% 아래입니다',
    labels: { alertname: 'DiskLow' },
    evalValues: { A: 0.14 },
    generatorUrl: null,
    endsAt: null,
    ...over,
  };
}
const resolved = (over: Partial<OpsAlertInput> = {}) =>
  input({ status: 'resolved', endsAt: new Date('2026-10-08T01:30:00Z'), ...over });

beforeEach(() => {
  rows = [];
  nextId = 1;
});

describe('알림 하나 지우기', () => {
  it('지우면 목록 · 안 읽은 수에서 빠지고, 다시 지워도 같다 (0)', async () => {
    const { fired } = await recordAlerts([input()]);
    expect((await listAlerts()).unread).toBe(1);

    expect(await dismissAlert(fired[0])).toBe(1);
    expect(await dismissAlert(fired[0])).toBe(0);
    expect(await dismissAlert(999)).toBe(0);
    expect(await listAlerts()).toEqual({ alerts: [], unread: 0 });
  });

  it('지운 사건을 Grafana 가 다시 보내면(반복) 다시 뜨지 않고 알리지도 않는다', async () => {
    const { fired } = await recordAlerts([input()]);
    await dismissAlert(fired[0]);

    const again = await recordAlerts([input({ evalValues: { A: 0.12 } })]);
    expect(again).toEqual({ fired: [], resolved: [], repeated: 1, dismissed: 0 });
    expect((await listAlerts()).alerts).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('지운 사건이 풀리면 상태만 맞추고 푸시 대상에 넣지 않는다', async () => {
    const { fired } = await recordAlerts([input()]);
    await dismissAlert(fired[0]);

    const r = await recordAlerts([resolved()]);
    expect(r).toEqual({ fired: [], resolved: [], repeated: 0, dismissed: 1 });
    expect(rows[0]).toMatchObject({ status: 'resolved', read_at: null });
    expect(rows[0].dismissed_at).not.toBeNull();
    expect((await listAlerts()).alerts).toEqual([]);
  });

  it('같은 규칙이 새로 울리면(시작 시각이 다름) 다시 뜬다', async () => {
    const { fired } = await recordAlerts([input()]);
    await dismissAlert(fired[0]);

    const next = await recordAlerts([input({ startsAt: new Date('2026-10-08T05:00:00Z') })]);
    expect(next.fired).toHaveLength(1);
    const { alerts, unread } = await listAlerts();
    expect(alerts.map((a) => a.id)).toEqual(next.fired);
    expect(unread).toBe(1);
  });

  it('지우지 않은 사건의 풀림은 그대로 새 소식 · 푸시 대상', async () => {
    const { fired } = await recordAlerts([input()]);
    await markAllAlertsRead();
    const r = await recordAlerts([resolved()]);
    expect(r.resolved).toEqual(fired);
    expect((await listAlerts()).unread).toBe(1);
  });
});

describe('풀린 알림 모두 지우기', () => {
  it('풀린 것만 지우고 울리는 중인 것은 남긴다', async () => {
    await recordAlerts([input({ fingerprint: 'a' }), input({ fingerprint: 'b' }), input({ fingerprint: 'c' })]);
    await recordAlerts([resolved({ fingerprint: 'a' }), resolved({ fingerprint: 'b' })]);

    expect(await dismissResolvedAlerts()).toBe(2);
    expect(await dismissResolvedAlerts()).toBe(0);
    const { alerts } = await listAlerts();
    expect(alerts.map((a) => [a.alertname, a.status])).toEqual([['DiskLow', 'firing']]);
  });

  it('읽음 처리는 지운 줄을 건드리지 않는다', async () => {
    const { fired } = await recordAlerts([input({ fingerprint: 'a' }), input({ fingerprint: 'b' })]);
    await dismissAlert(fired[0]);
    expect(await markAllAlertsRead()).toBe(1);
    expect(rows.find((r) => r.id === fired[0])?.read_at).toBeNull();
  });
});
