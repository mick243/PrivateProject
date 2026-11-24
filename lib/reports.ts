import { MIN_ACCOUNT_AGE_HOURS } from './account-age';
import { getArcade, listMachines } from './arcades';
import { cacheReference } from './cache';
import type { MachineReport, PresenceOutcome, ReportKind } from './community-types';
import type { Prisma } from './generated/prisma/client.ts';
import { isForeignKeyViolation } from './pg-errors';
import { purgeExpiredQueueReports as purgeExpiredQueueReportsSql } from './typed-sql';
import { getPrismaClient, iso, TX_OPTIONS, type PrismaTx } from './prisma';
import type { Arcade } from './types';

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
  /**
   * 세션 주인의 닉네임(lib/auth.ts getSession). 응답의 report.nickname 으로 그대로 나갑니다 —
   * 저장한 뒤 players 를 다시 읽지 않으려고 받습니다. 익명이면 무시합니다.
   */
  nickname?: string | null;
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
  /**
   * 제보를 반영한 뒤의 오락실 (응답에 그대로 싣습니다 — 있어요/없어졌어요가 목록을 바꿀 수 있어서).
   * report 의 오락실 이름 · 기체 수도 여기서 꺼냅니다. 그 사이 오락실이 지워졌으면 null.
   */
  arcade: Arcade | null;
}

/** 등록되지 않은 기종에 대기/컨디션 제보가 들어온 경우 */
export class MachineNotAtArcadeError extends Error {
  constructor() {
    super('이 오락실에 아직 없는 게임이에요. 먼저 "이 게임 있어요"로 알려 주세요');
  }
}

/** 제보를 받을 오락실이 없는 경우 (지워졌거나 잘못된 번호) */
export class ArcadeNotFoundError extends Error {
  constructor() {
    super('오락실을 찾을 수 없어요. 지워졌을 수 있어요');
  }
}

/** 기종 목록에 없는 기종 번호 */
export class UnknownMachineError extends Error {
  constructor() {
    super('그 게임을 찾을 수 없어요. 새로고침한 뒤 다시 알려 주세요');
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
    super('그 기계를 찾을 수 없어요. 목록이 바뀌었을 수 있으니 새로고침한 뒤 다시 알려 주세요');
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
 * 별도 스케줄러가 없으므로 **피드를 읽을 때** 함께 돈다. 서버가 놀고 있는 동안에는
 * 남아 있다가 다음 요청에 정리된다. 그 사이에도 화면에는 안 보인다 — machine_live 뷰가
 * 같은 설정값으로 한 번 더 거른다. (2026-11-24 까지는 제보를 쓸 때도 돌았다 — 쓰기 한 건의
 * 문장을 줄이려고 뺐다. 지우는 시점이 피드 조회로 늦어질 뿐 보이는 것은 같다.)
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

/*
 * 설정은 마이그레이션이 넣는 기준 데이터라(lib/data-release.ts) 5분 캐시에 둡니다(2026-11-24).
 * DB 에서 값을 직접 고치면 최대 5분 뒤에 반영됩니다. 대기 제보를 지우는 SQL 과 machine_live 뷰는
 * 표를 직접 읽으므로 수명(queue_ttl_minutes)은 바로 반영되고, 늦는 것은 있어요/없어졌어요
 * 임계값과 피드 화면의 표시값뿐입니다.
 */
export const getReportSettings = cacheReference(getReportSettingsUncached, 'report-settings');

async function getReportSettingsUncached(): Promise<ReportSettings> {
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

/** 가입 후 이 시간이 지난 계정만 있어요/없어졌어요 임계값에 센다 (투표·리뷰와 같은 기준 — lib/account-age.ts) */
export { MIN_ACCOUNT_AGE_HOURS };

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

/** 저장 직후 응답에 쓰는 열 — 관계는 읽지 않는다 (createReport 주석) */
const createdSelect = {
  id: true,
  arcade_id: true,
  machine_id: true,
  cabinet_id: true,
  player_id: true,
  kind: true,
  wait_count: true,
  condition: true,
  comment: true,
  created_at: true,
} satisfies Prisma.machine_reportsSelect;

/**
 * 확인 쿼리가 비었을 때 **왜** 비었는지 가린다. 오류 경로에서만 불러 정상 경로의 왕복을 늘리지 않는다.
 * 오락실이 없으면 404, 기종이 없으면 "먼저 있어요로", 기종은 있는데 기체가 없으면 "새로고침".
 */
async function explainMissing(
  prisma: Awaited<ReturnType<typeof getPrismaClient>>,
  input: ReportInput,
): Promise<never> {
  const arcade = await prisma.arcades.findUnique({
    where: { id: input.arcadeId },
    select: {
      id: true,
      arcade_machines: { where: { machine_id: input.machineId }, select: { machine_id: true } },
    },
  });
  if (!arcade) throw new ArcadeNotFoundError();
  if (arcade.arcade_machines.length === 0) throw new MachineNotAtArcadeError();
  throw new CabinetNotFoundError();
}

/**
 * 제보 한 건을 저장하고, 반영된 오락실과 함께 돌려준다.
 *
 * **DB 왕복을 세어 가며 짠 경로입니다 (2026-11-24).** 그 전에는 대기 제보 한 건이 SQL 16문장,
 * 있어요가 18문장이었습니다 — 라우트의 오락실 확인(getArcade) · 설정 조회 · 낡은 대기 제보 정리 ·
 * 저장한 행을 관계 4개와 함께 다시 읽기(5문장) · 기체 수 집계 · 응답용 getArcade. 지금은:
 *   - 오락실이 있는지 미리 보지 않습니다. 대기 · 컨디션은 아래 확인 쿼리가 비면, 있어요/없어졌어요는
 *     외래 키 위반이 나면 그때 한 번 더 보고 404 로 가립니다(explainMissing).
 *   - 기종 이름은 기종 목록 캐시(listMachines)에서, 기체 번호는 컨디션 확인 쿼리에서, 닉네임은
 *     세션에서(input.nickname), 오락실 이름 · 기체 수는 어차피 응답에 싣는 getArcade 에서 꺼냅니다.
 *   - 트랜잭션은 있어요/없어졌어요만 엽니다 — 저장과 임계값 반영(applyPresence)이 함께여야 해서입니다.
 *     대기 · 컨디션은 INSERT 한 문장이라 트랜잭션이 필요 없습니다.
 *   - 낡은 대기 제보 정리는 피드를 읽을 때만 합니다(purgeExpiredQueueReports).
 * 측정은 PERFORMANCE.md 6부 「쓰기 경로와 서열표의 문장 수 줄이기」.
 */
export async function createReport(input: ReportInput): Promise<CreateReportResult> {
  const prisma = await getPrismaClient();

  const machine = (await listMachines()).find((m) => m.id === input.machineId);
  if (!machine) throw new UnknownMachineError();

  // 대기/컨디션은 "그 오락실에 그 기종이 있다"는 전제 위에서만 의미가 있다.
  // 없는 기종의 대기 제보를 받아두면 machine_live 에 아무도 볼 수 없는 행이 쌓인다.
  //
  // 컨디션은 기체 1대에 대한 제보다. id 만 믿지 않고 그 기체가 정말 이 오락실의
  // 이 기종인지 확인한다 — 남의 오락실 기체 id 를 보내면 화면에 뜨지도 않을
  // 제보가 그쪽 집계에 섞인다. 기체는 (오락실, 기종)을 외래 키로 물고 있으므로
  // 기체가 있으면 기종도 있다 — 컨디션은 이 한 번으로 둘 다 확인한다.
  let cabinetNo: number | null = null;
  if (input.kind === 'condition') {
    const cabinet =
      input.cabinetId === null
        ? null
        : await prisma.arcade_cabinets.findFirst({
            where: { id: input.cabinetId, arcade_id: input.arcadeId, machine_id: input.machineId },
            select: { cabinet_no: true },
          });
    if (!cabinet) return explainMissing(prisma, input);
    cabinetNo = cabinet.cabinet_no;
  } else if (input.kind === 'queue') {
    const registered = await prisma.arcade_machines.findUnique({
      where: { arcade_id_machine_id: { arcade_id: input.arcadeId, machine_id: input.machineId } },
      select: { arcade_id: true },
    });
    if (!registered) return explainMissing(prisma, input);
  }

  const data = {
    arcade_id: input.arcadeId,
    machine_id: input.machineId,
    cabinet_id: input.cabinetId,
    player_id: input.playerId,
    kind: input.kind,
    wait_count: input.waitCount,
    condition: input.condition,
    comment: input.comment,
  };

  let saved: Prisma.machine_reportsGetPayload<{ select: typeof createdSelect }>;
  let outcome: PresenceOutcome = null;
  let support: CreateReportResult['support'] = null;
  try {
    if (input.kind === 'presence' || input.kind === 'absence') {
      const kind = input.kind;
      const { presenceThreshold } = await getReportSettings();
      saved = await prisma.$transaction(async (tx) => {
        const row = await tx.machine_reports.create({ data, select: createdSelect });
        const applied = await applyPresence(tx, input.arcadeId, input.machineId, kind, presenceThreshold);
        outcome = applied.outcome;
        support = { count: applied.count, threshold: presenceThreshold };
        return row;
      }, TX_OPTIONS);
    } else {
      saved = await prisma.machine_reports.create({ data, select: createdSelect });
    }
  } catch (err) {
    // 확인 뒤 저장 사이에 오락실이 지워졌거나(대기 · 컨디션), 처음부터 없는 오락실(있어요/없어졌어요)
    if (isForeignKeyViolation(err)) return explainMissing(prisma, input);
    throw err;
  }

  const arcade = await getArcade(input.arcadeId);
  const owned = arcade?.machines.find((m) => m.id === input.machineId);
  const report: MachineReport = {
    id: saved.id,
    arcadeId: saved.arcade_id,
    arcadeName: arcade?.name ?? '',
    machineId: saved.machine_id,
    machineName: machine.name,
    machineShortName: machine.shortName,
    cabinetId: saved.cabinet_id,
    cabinetNo,
    // 피드(listReports)와 같은 뜻 — 지금 그 기종의 대수. 없어졌어요로 빠졌으면 0
    cabinetCount: owned?.cabinets.length ?? 0,
    playerId: saved.player_id,
    nickname: saved.player_id === null ? null : (input.nickname ?? null),
    kind: saved.kind as ReportKind,
    waitCount: saved.wait_count,
    condition: saved.condition,
    comment: saved.comment ?? null,
    createdAt: iso(saved.created_at),
  };
  return { report, outcome, support, arcade };
}
