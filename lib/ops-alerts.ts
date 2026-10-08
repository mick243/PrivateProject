import type { ops_alerts, Prisma } from './generated/prisma/client.ts';
import { tidyAi, type OpsAlertInput } from './ops-alert-input';
import {
  OPS_ALERTS_LIST_LIMIT,
  type OpsAlertAi,
  type OpsAlertStatus,
  type OpsAlertView,
} from './ops-alert-types';
import { getPrismaClient, iso } from './prisma';

/**
 * 운영 알림 표(ops_alerts, db/migrate-081-ops-alerts.sql)를 읽고 쓰는 곳.
 *
 * 받는 길은 둘입니다 — Grafana Cloud 의 알림 웹훅(POST /api/ops/alerts)과 관리자의 시험 알림
 * (POST /api/ops/alerts/test). 둘 다 recordAlerts 로 적고, 요약 · 푸시는 응답한 뒤에
 * lib/ops-alert-events.ts 가 합니다. 이 파일은 표만 만집니다.
 */

/** 이보다 오래 손대지 않은 줄은 받을 때 지웁니다 — 화면은 최근 30개만 보여 줍니다 */
const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 이번에 받은 것 중 알릴 일이 생긴 줄 */
export interface RecordResult {
  /** 새로 울리기 시작한 것 — 요약을 만들고 푸시합니다 */
  fired: number[];
  /** 울리던 것이 풀린 것(또는 울림을 못 받고 풀림만 받은 것) — 푸시만 합니다 */
  resolved: number[];
  /** Grafana 가 다시 보낸 같은 상태 — 몇 시간마다 옵니다. 알리지 않습니다 */
  repeated: number;
}

/** Prisma 가 유니크 위반을 던졌는가 (같은 알림이 두 웹훅으로 동시에 온 경우) */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export async function recordAlerts(inputs: OpsAlertInput[]): Promise<RecordResult> {
  const prisma = await getPrismaClient();
  const result: RecordResult = { fired: [], resolved: [], repeated: 0 };

  for (const a of inputs) {
    const key = { fingerprint_starts_at: { fingerprint: a.fingerprint, starts_at: a.startsAt } };
    let row = await prisma.ops_alerts.findUnique({ where: key, select: { id: true, status: true } });

    if (!row) {
      try {
        const created = await prisma.ops_alerts.create({
          data: {
            fingerprint: a.fingerprint,
            starts_at: a.startsAt,
            status: a.status,
            alertname: a.alertname,
            severity: a.severity,
            summary: a.summary,
            labels: a.labels as Prisma.InputJsonValue,
            eval_values: (a.evalValues ?? undefined) as Prisma.InputJsonValue | undefined,
            generator_url: a.generatorUrl,
            ends_at: a.status === 'resolved' ? (a.endsAt ?? new Date()) : null,
          },
          select: { id: true },
        });
        (a.status === 'firing' ? result.fired : result.resolved).push(created.id);
        continue;
      } catch (err) {
        // 같은 사건이 동시에 두 번 왔다 — 먼저 들어간 줄을 기준으로 아래에서 상태만 맞춥니다
        if (!isUniqueViolation(err)) throw err;
        row = await prisma.ops_alerts.findUnique({ where: key, select: { id: true, status: true } });
        if (!row) throw err;
      }
    }

    if (row.status === 'firing' && a.status === 'resolved') {
      await prisma.ops_alerts.update({
        where: { id: row.id },
        // 풀림은 새 소식이라 다시 안 읽은 것으로 — 종 아이콘에 다시 숫자가 뜹니다
        data: { status: 'resolved', ends_at: a.endsAt ?? new Date(), updated_at: new Date(), read_at: null },
      });
      result.resolved.push(row.id);
    } else {
      // 같은 상태를 다시 보낸 것. 울리는 동안 값이 바뀌었을 수 있어 그것만 새로
      if (a.status === 'firing' && a.evalValues) {
        await prisma.ops_alerts.update({
          where: { id: row.id },
          data: { eval_values: a.evalValues as Prisma.InputJsonValue },
        });
      }
      result.repeated++;
    }
  }

  await prisma.ops_alerts.deleteMany({ where: { updated_at: { lt: new Date(Date.now() - KEEP_DAYS * DAY_MS) } } });
  return result;
}

/** 요약을 만들 때 쓰는 한 줄 — 표에 적힌 그대로 입력 모양으로 되돌립니다 */
export async function getAlertInput(id: number): Promise<(OpsAlertInput & { hasSummary: boolean }) | null> {
  const prisma = await getPrismaClient();
  const r = await prisma.ops_alerts.findUnique({ where: { id } });
  if (!r) return null;
  return {
    fingerprint: r.fingerprint,
    startsAt: r.starts_at,
    status: r.status as OpsAlertStatus,
    alertname: r.alertname,
    severity: r.severity,
    summary: r.summary,
    labels: (r.labels ?? {}) as Record<string, string>,
    evalValues: (r.eval_values ?? null) as Record<string, number> | null,
    generatorUrl: r.generator_url,
    endsAt: r.ends_at,
    hasSummary: r.ai_summary !== null,
  };
}

/** 같은 규칙이 최근 7일 동안 울린 횟수 (이번 것 포함) — 모델이 "자주 울리는 것" 인지 압니다 */
export async function countRecentFirings(alertname: string): Promise<number> {
  const prisma = await getPrismaClient();
  return prisma.ops_alerts.count({
    where: { alertname, starts_at: { gte: new Date(Date.now() - 7 * DAY_MS) } },
  });
}

export async function saveAlertSummary(id: number, ai: OpsAlertAi | null, error: string | null): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.ops_alerts.update({
    where: { id },
    data: { ai_summary: (ai ?? undefined) as Prisma.InputJsonValue | undefined, ai_error: error },
  });
}

function toView(r: ops_alerts): OpsAlertView {
  return {
    id: r.id,
    status: r.status as OpsAlertStatus,
    alertname: r.alertname,
    severity: r.severity,
    summary: r.summary,
    startsAt: iso(r.starts_at),
    endsAt: r.ends_at ? iso(r.ends_at) : null,
    updatedAt: iso(r.updated_at),
    read: r.read_at !== null,
    // 저장할 때 다듬은 값이지만, 모양이 바뀐 옛 줄이 있어도 화면이 깨지지 않게 한 번 더
    ai: tidyAi(r.ai_summary),
    aiError: r.ai_error,
    grafanaUrl: r.generator_url,
  };
}

export async function getAlertView(id: number): Promise<OpsAlertView | null> {
  const prisma = await getPrismaClient();
  const r = await prisma.ops_alerts.findUnique({ where: { id } });
  return r ? toView(r) : null;
}

/** 최근 알림 (바뀐 때 순, 같으면 id 순 — GUIDELINES.md §4-4) 과 안 읽은 수 */
export async function listAlerts(): Promise<{ alerts: OpsAlertView[]; unread: number }> {
  const prisma = await getPrismaClient();
  const [rows, unread] = await Promise.all([
    prisma.ops_alerts.findMany({
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      take: OPS_ALERTS_LIST_LIMIT,
    }),
    prisma.ops_alerts.count({ where: { read_at: null } }),
  ]);
  return { alerts: rows.map(toView), unread };
}

/** 안 읽은 것을 모두 읽음으로 — 관리자가 목록을 열면 부릅니다. 여러 번 불러도 같습니다 */
export async function markAllAlertsRead(): Promise<number> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.ops_alerts.updateMany({ where: { read_at: null }, data: { read_at: new Date() } });
  return count;
}
