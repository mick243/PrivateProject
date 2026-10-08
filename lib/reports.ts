import type { MachineReport, PresenceOutcome, ReportKind } from './community-types';
import type { Prisma } from './generated/prisma/client.ts';
import { purgeExpiredQueueReports as purgeExpiredQueueReportsSql } from './typed-sql';
import { getPrismaClient, iso, TX_OPTIONS, type PrismaTx } from './prisma';

/**
 * 기종 제보 — "이 게임 있어요" / "없어졌어요" / "지금 대기 N명" / "컨디션".
 *
 * 네 종류를 한 테이블에 담는 이유: 넷 다 (오락실, 기종, 누가, 언제) 가 본체이고
 * 다른 건 페이로드 한 칸뿐입니다. 테이블을 넷으로 쪼개면 "이 오락실 최근 제보"
 * 같은 화면이 4-way UNION 이 됩니다.
 */

export interface ReportSettings {
  queueTtlMinutes: number;
  conditionWindowDays: number;
  presenceThreshold: number;
}

export interface ReportInput {
  arcadeId: number;
  machineId: number;
  /**
   * 컨디션 제보가 가리키는 기체. 컨디션이면 필수이고 나머지 종류는 null 입니다
   * — 대기는 기종 단위이고, 있어요/없어졌어요는 기종 자체에 대한 제보입니다.
   */
  cabinetId: number | null;
  /** null = 익명 제보 */
  playerId: number | null;
  kind: ReportKind;
  waitCount: number | null;
  condition: number | null;
  comment: string | null;
}

export interface CreateReportResult {
  report: MachineReport;
  /** 임계값이 차서 arcade_machines 가 실제로 바뀌었으면 그 방향 */
  outcome: PresenceOutcome;
  /** presence/absence 제보일 때 "몇 명 중 몇 명" — UI 에 진행도를 보여주기 위해 */
  support: { count: number; threshold: number } | null;
}

/** 등록되지 않은 기종에 대기/컨디션 제보가 들어온 경우 */
export class MachineNotAtArcadeError extends Error {
  constructor() {
    super('그 오락실에 등록되지 않은 기종입니다. 먼저 "이 게임 있어요" 로 제보해 주세요.');
  }
}

/**
 * 컨디션 제보가 가리키는 기체가 없는 경우.
 *
 * 화면을 열어 둔 사이에 누가 대수를 줄이면 사라진 호기에 제보가 날아온다.
 * 다른 기체로 옮겨 붙이지 않는다 — 2호기 얘기를 1호기에 적는 셈이 된다.
 */
export class CabinetNotFoundError extends Error {
  constructor() {
    super('그 기체를 찾을 수 없습니다. 목록이 바뀌었을 수 있으니 새로고침 후 다시 시도해 주세요.');
  }
}

/**
 * 수명이 지난 대기 제보를 **지운다**.
 *
 * 대기 인원은 되돌아볼 값이 아니라 지나면 그냥 틀린 값이다. 20시간 전 "대기 5명"
 * 은 아무에게도 쓸모가 없는데, 남겨 두면 전국 피드의 '최근 24시간' 을 채워
 * 방금 올라온 제보를 밀어낸다. 컨디션·있어요/없어졌어요는 누적이 근거가 되므로
 * 그대로 둔다 — 지우는 건 queue 뿐이다.
 *
 * 별도 스케줄러가 없으므로 **제보를 쓸 때와 피드를 읽을 때** 함께 돈다. 서버가
 * 놀고 있는 동안에는 남아 있다가 다음 요청에 정리된다. 그 사이에도 화면에는
 * 안 보인다 — machine_live 뷰가 같은 설정값으로 한 번 더 거른다.
 *
 * 기준 시각은 앱이 아니라 DB 의 now() 다. 두 곳에서 시간을 재면 서버 시계가
 * 조금만 어긋나도 뷰에는 보이는데 이미 지워진 행이 생긴다 — 그래서 이 문장은
 * TypedSQL 로 둔다 (prisma/sql/purgeExpiredQueueReports.sql).
 */
export async function purgeExpiredQueueReports(): Promise<number> {
  const prisma = await getPrismaClient();
  const rows = await prisma.$queryRawTyped(purgeExpiredQueueReportsSql());
  return rows.length;
}

export async function getReportSettings(): Promise<ReportSettings> {
  const prisma = await getPrismaClient();
  const r = await prisma.report_settings.findUnique({ where: { id: 1 } });
  return {
    // fallback 은 schema-community.sql 의 DEFAULT 와 같은 값이어야 합니다.
    queueTtlMinutes: r?.queue_ttl_minutes ?? 240,
    conditionWindowDays: r?.condition_window_days ?? 30,
    presenceThreshold: r?.presence_threshold ?? 2,
  };
}

/**
 * 피드 한 줄에 붙는 관계 — 옛 FEED_SELECT 의 조인들.
 * 컨디션 제보만 기체를 가리킨다. 기체가 지워진 옛 제보도 여기서 null 이 된다.
 */
const reportInclude = {
  arcades: { select: { name: true } },
  machines: { select: { name: true, short_name: true } },
  arcade_cabinets: { select: { cabinet_no: true } },
  players: { select: { nickname: true } },
} satisfies Prisma.machine_reportsInclude;

type ReportRow = Prisma.machine_reportsGetPayload<{ include: typeof reportInclude }>;

/** `${arcadeId}:${machineId}` */
const pairKey = (arcadeId: number, machineId: number) => `${arcadeId}:${machineId}`;

/**
 * (오락실, 기종)별 기체 수.
 *
 * 대기 구간이 기체당 인원으로 정해지므로(lib/community-types.ts WAIT_LEVELS) 피드도 대수를
 * 알아야 상세와 같은 문구가 나온다. 옛 SQL 은 행마다 상관 서브쿼리였고, 여기서는 결과에
 * 등장한 조합만 한 번에 센다.
 */
async function cabinetCounts(
  client: PrismaTx | Awaited<ReturnType<typeof getPrismaClient>>,
  rows: { arcade_id: number; machine_id: number }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const pairs = [...new Map(rows.map((r) => [pairKey(r.arcade_id, r.machine_id), r])).values()];
  const grouped = await client.arcade_cabinets.groupBy({
    by: ['arcade_id', 'machine_id'],
    where: { OR: pairs.map((p) => ({ arcade_id: p.arcade_id, machine_id: p.machine_id })) },
    _count: { _all: true },
  });
  for (const g of grouped) out.set(pairKey(g.arcade_id, g.machine_id), g._count._all);
  return out;
}

function toReport(r: ReportRow, cabinetCount: number): MachineReport {
  return {
    id: r.id,
    arcadeId: r.arcade_id,
    arcadeName: r.arcades.name,
    machineId: r.machine_id,
    machineName: r.machines.name,
    machineShortName: r.machines.short_name,
    cabinetId: r.cabinet_id,
    cabinetNo: r.arcade_cabinets?.cabinet_no ?? null,
    cabinetCount,
    playerId: r.player_id,
    nickname: r.players?.nickname ?? null,
    kind: r.kind as ReportKind,
    waitCount: r.wait_count,
    condition: r.condition,
    comment: r.comment ?? null,
    createdAt: iso(r.created_at),
  };
}

export interface ListReportsParams {
  arcadeId?: number | null;
  machineId?: number | null;
  kinds?: ReportKind[] | null;
  /** 이 시간 안의 제보만 (전국 피드 기본값용) */
  sinceHours?: number | null;
  /**
   * 오락실 이름 · 기종 이름 · 메모 부분 일치 (피드 검색창).
   *
   * 화면에 보이는 것만 찾습니다 — 피드 한 줄이 곧 (오락실, 기종, 메모) 라서,
   * 눈에 보이는 글자로 찾았는데 안 나오거나 안 보이는 글자로 걸리는 일이 없어야
   * 합니다. 닉네임은 넣지 않았습니다: 검색은 "지금 저기 어때요" 를 찾는 도구이고,
   * 사람 이름으로 제보를 모아 보는 건 다른 기능입니다.
   *
   * 기종은 셀렉트로도 좁힐 수 있지만 여기에도 넣습니다 — 짧은 이름('사볼')과
   * 정식 이름('SOUND VOLTEX') 둘 다 받으므로, 목록에서 고르는 것보다 타이핑이
   * 빠른 사람의 길을 막지 않습니다.
   *
   * ⚠ **인덱스를 타지 않는 조건입니다.** 찾을 글자가 arcades·machines·
   *   machine_reports 세 테이블에 흩어져 OR 로 묶이는데, 여러 테이블에 걸친
   *   OR 은 비트맵으로 합칠 수 없어서 trigram 인덱스를 걸어도 플래너가 쓰지
   *   못합니다. 실제로는 기간 조건이 먼저 좁혀 줍니다 (machine_reports_feed_idx 의
   *   created_at). 그게 문제가 될 만큼 제보가 쌓이면 손볼 곳은 인덱스가 아니라
   *   조건의 모양입니다 — 이름을 제보 행에 비정규화해 한 테이블 안에서 찾게 만드는 쪽.
   */
  q?: string | null;
  limit?: number;
  /** 건너뛸 수 — 챗봇 도구의 쪽 넘기기 (최신순이라 새 제보가 오면 한 칸씩 밀릴 수 있습니다) */
  offset?: number;
}

export async function listReports(params: ListReportsParams): Promise<MachineReport[]> {
  const prisma = await getPrismaClient();
  const {
    arcadeId = null,
    machineId = null,
    kinds = null,
    sinceHours = null,
    q = null,
    limit = 50,
    offset = 0,
  } = params;

  // 빈 검색어는 조건을 걸지 않는 것과 같다.
  const term = q && q.trim() ? q.trim() : null;

  // 피드를 읽는 김에 수명이 다한 대기 제보를 치운다. 스케줄러가 없으므로
  // "누군가 볼 때 정리한다" 가 이 앱에서 가장 확실한 시점이다.
  await purgeExpiredQueueReports();

  const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });
  const where: Prisma.machine_reportsWhereInput = {
    ...(arcadeId !== null ? { arcade_id: arcadeId } : {}),
    ...(machineId !== null ? { machine_id: machineId } : {}),
    ...(kinds && kinds.length ? { kind: { in: kinds } } : {}),
    ...(sinceHours !== null
      ? { created_at: { gt: new Date(Date.now() - sinceHours * 60 * 60 * 1000) } }
      : {}),
    ...(term !== null
      ? {
          OR: [
            { arcades: { name: contains(term) } },
            { machines: { name: contains(term) } },
            { machines: { short_name: contains(term) } },
            { comment: contains(term) },
          ],
        }
      : {}),
  };

  const rows = await prisma.machine_reports.findMany({
    where,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit,
    skip: offset,
    include: reportInclude,
  });
  const counts = await cabinetCounts(prisma, rows);
  return rows.map((r) => toReport(r, counts.get(pairKey(r.arcade_id, r.machine_id)) ?? 0));
}

/**
 * 제보 한 건을 지운다 (관리자 전용 — app/api/reports/[id]/route.ts).
 *
 * append-only 로그에 구멍을 내는 유일한 경로다. 장난 제보나 개인정보가 섞인
 * 메모는 남겨 둘 수 없는데, 제보는 수정할 수단이 없어서 지우는 것 말고는
 * 손댈 방법이 없다.
 *
 * ⚠ 지운다고 arcade_machines 가 되돌아가지는 않는다. 있어요/없어졌어요의 자동
 *   반영은 제보가 들어온 그 순간에 한 번 계산되고 끝나므로(applyPresence),
 *   근거가 된 제보를 나중에 지워도 이미 붙거나 빠진 기종은 그대로다. 잘못
 *   반영된 기종은 오락실 수정(관리자 전용)에서 직접 되돌린다 — 제보 삭제가
 *   조용히 지도를 바꾸는 쪽이 더 위험하다.
 */
export async function deleteReport(id: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.machine_reports.deleteMany({ where: { id } });
  return count > 0;
}

/**
 * 있어요/없어졌어요 제보를 세어 임계값을 넘으면 arcade_machines 를 갱신한다.
 *
 * 세는 구간은 "반대 제보가 마지막으로 들어온 뒤" 다. 이걸 안 잡으면 3년 전
 * '있어요' 2건이 오늘의 '없어졌어요' 를 영구히 이기고, 기종이 빠진 오락실을
 * 지도에서 지울 수 없게 된다.
 *
 * 익명 제보(player_id IS NULL)는 세지 않는다 — 한 사람이 새로고침만 해도
 * 임계값을 채울 수 있으면 임계값이 아무 의미가 없다. 제보 자체는 남는다.
 *
 * **막 만든 계정도 세지 않는다** (MIN_ACCOUNT_AGE_HOURS). 임계값이 2명이라,
 * 가입 제한이 없는 배포에서는 일회용 계정 2개로 임의 오락실의 기종을 넣고 뺄 수
 * 있었다 (2026-09-13 QA B5). 계정을 만든 뒤 하루가 지나야 표가 된다 — 지도의
 * 근거를 바꾸는 표는 "지나가다 만든 계정" 이 아니라 "쓰고 있는 계정" 의 것이어야
 * 한다. 제보 자체는 즉시 남고 피드에도 보인다.
 */

/** 가입 후 이 시간이 지난 계정만 있어요/없어졌어요 임계값에 센다 */
export const MIN_ACCOUNT_AGE_HOURS = 24;

async function applyPresence(
  tx: PrismaTx,
  arcadeId: number,
  machineId: number,
  kind: 'presence' | 'absence',
  threshold: number,
): Promise<{ count: number; outcome: PresenceOutcome }> {
  const opposite = kind === 'presence' ? 'absence' : 'presence';

  // 반대 제보가 마지막으로 들어온 시각 — 그 뒤의 표만 센다.
  const boundary = await tx.machine_reports.findFirst({
    where: { arcade_id: arcadeId, machine_id: machineId, kind: opposite },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });

  const votes = await tx.machine_reports.findMany({
    where: {
      arcade_id: arcadeId,
      machine_id: machineId,
      kind,
      player_id: { not: null },
      ...(boundary ? { created_at: { gt: boundary.created_at } } : {}),
    },
    select: { player_id: true, created_at: true, players: { select: { created_at: true } } },
  });

  // 계정 나이 조건 — 제보 시각을 자르는 것이 아니라 표를 낸 계정의 나이를 본다.
  const minAgeMs = MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;
  const voters = new Set<number>();
  for (const v of votes) {
    if (v.player_id === null || !v.players) continue;
    if (v.players.created_at.getTime() + minAgeMs <= v.created_at.getTime()) voters.add(v.player_id);
  }
  const count = voters.size;
  if (count < threshold) return { count, outcome: null };

  if (kind === 'presence') {
    // 이미 등록돼 있으면 아무 일도 일어나지 않는다 (outcome = null).
    const added = await tx.arcade_machines.createMany({
      data: [{ arcade_id: arcadeId, machine_id: machineId }],
      skipDuplicates: true,
    });
    if (added.count > 0) {
      // 기체가 0대면 화면에 카드가 하나도 없어 컨디션 제보를 받을 자리가 없다.
      // 몇 대인지는 아무도 제보하지 않았으므로 1대로 시작하고, 나머지는
      // 오락실 수정에서 늘린다.
      await tx.arcade_cabinets.createMany({
        data: [{ arcade_id: arcadeId, machine_id: machineId, cabinet_no: 1 }],
        skipDuplicates: true,
      });
    }
    return { count, outcome: added.count > 0 ? 'added' : null };
  }

  const removed = await tx.arcade_machines.deleteMany({
    where: { arcade_id: arcadeId, machine_id: machineId },
  });
  return { count, outcome: removed.count > 0 ? 'removed' : null };
}

export async function createReport(input: ReportInput): Promise<CreateReportResult> {
  const prisma = await getPrismaClient();
  const { presenceThreshold } = await getReportSettings();

  // 새 제보가 들어오는 김에 낡은 대기 제보를 치운다 (읽기 경로는 listReports).
  await purgeExpiredQueueReports();

  // 대기/컨디션은 "그 오락실에 그 기종이 있다"는 전제 위에서만 의미가 있다.
  // 없는 기종의 대기 제보를 받아두면 machine_live 에 아무도 볼 수 없는 행이 쌓인다.
  if (input.kind === 'queue' || input.kind === 'condition') {
    const registered = await prisma.arcade_machines.findUnique({
      where: { arcade_id_machine_id: { arcade_id: input.arcadeId, machine_id: input.machineId } },
      select: { arcade_id: true },
    });
    if (!registered) throw new MachineNotAtArcadeError();
  }

  // 컨디션은 기체 1대에 대한 제보다. id 만 믿지 않고 그 기체가 정말 이 오락실의
  // 이 기종인지 확인한다 — 남의 오락실 기체 id 를 보내면 화면에 뜨지도 않을
  // 제보가 그쪽 집계에 섞인다.
  if (input.kind === 'condition') {
    const cabinet =
      input.cabinetId === null
        ? null
        : await prisma.arcade_cabinets.findFirst({
            where: { id: input.cabinetId, arcade_id: input.arcadeId, machine_id: input.machineId },
            select: { id: true },
          });
    if (!cabinet) throw new CabinetNotFoundError();
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.machine_reports.create({
      data: {
        arcade_id: input.arcadeId,
        machine_id: input.machineId,
        cabinet_id: input.cabinetId,
        player_id: input.playerId,
        kind: input.kind,
        wait_count: input.waitCount,
        condition: input.condition,
        comment: input.comment,
      },
      select: { id: true },
    });

    let outcome: PresenceOutcome = null;
    let support: CreateReportResult['support'] = null;

    if (input.kind === 'presence' || input.kind === 'absence') {
      const applied = await applyPresence(
        tx,
        input.arcadeId,
        input.machineId,
        input.kind,
        presenceThreshold,
      );
      outcome = applied.outcome;
      support = { count: applied.count, threshold: presenceThreshold };
    }

    const full = await tx.machine_reports.findUniqueOrThrow({
      where: { id: created.id },
      include: reportInclude,
    });
    const counts = await cabinetCounts(tx, [full]);
    return {
      report: toReport(full, counts.get(pairKey(full.arcade_id, full.machine_id)) ?? 0),
      outcome,
      support,
    };
  }, TX_OPTIONS);
}
