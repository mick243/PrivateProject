/**
 * 신고 · 차단 · 계정 정지 · AI 기종 추정 검수 (db/migrate-083-moderation.sql).
 *
 * ─── 왜 (2026-11-20 문제점 조사) ──────────────────────────────
 * 신고는 개인정보처리방침의 메일 주소로만 받았고, 관리자 화면은 이모티콘 관리 하나뿐이라 계정 정지 ·
 * AI 추정 승인은 DB 를 직접 고쳐야 했습니다. 여기 모은 함수를 관리자 화면(/admin, components/AdminConsole.tsx)
 * 과 사용자 쪽 신고 · 차단 단추(components/ReportMenu.tsx)가 씁니다.
 *
 * 지우기는 이미 있는 함수(lib/board.ts deletePostAsAdmin 등)를 그대로 부릅니다 — 집계 다시 세기 ·
 * 요약 캐시 버리기 같은 뒷정리가 거기 있어서, 여기서 행을 직접 지우면 그것이 빠집니다.
 *
 * 서버 전용입니다 (Prisma).
 */

import { listMachines } from './arcades';
import { deleteCommentAsAdmin, deletePostAsAdmin } from './board';
import {
  INDEFINITE_UNTIL,
  REPORT_DETAIL_MAX,
  type AdminPlayerRow,
  type BlockedPlayer,
  type GuessRow,
  type ReportGroup,
  type ReportReason,
  type ReportStatus,
  type ReportTarget,
} from './moderation-types';
import { getPrismaClient } from './prisma';
import { deleteReviewById } from './reviews';

/** 발췌 길이 — 신고함에서 한눈에 볼 만큼 */
const EXCERPT_CHARS = 200;

const clip = (s: string | null | undefined, max = EXCERPT_CHARS): string | null => {
  if (!s) return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

// ─── 대상 찾기 ───────────────────────────────────────────────

interface TargetInfo {
  authorId: number;
  excerpt: string | null;
  href: string;
}

/** 신고 대상의 작성자 · 발췌 · 화면 주소. 없으면 null */
async function findTarget(type: ReportTarget, id: number): Promise<TargetInfo | null> {
  const prisma = await getPrismaClient();
  switch (type) {
    case 'post': {
      const row = await prisma.posts.findUnique({
        where: { id },
        select: { player_id: true, title: true, body: true },
      });
      return row && { authorId: row.player_id, excerpt: clip(`${row.title} — ${row.body}`), href: `/community?post=${id}` };
    }
    case 'post_comment': {
      const row = await prisma.post_comments.findUnique({
        where: { id },
        select: { player_id: true, body: true, post_id: true },
      });
      return row && { authorId: row.player_id, excerpt: clip(row.body), href: `/community?post=${row.post_id}` };
    }
    case 'arcade_review': {
      const row = await prisma.arcade_reviews.findUnique({
        where: { id },
        select: { player_id: true, body: true, rating: true, arcade_id: true },
      });
      return (
        row && {
          authorId: row.player_id,
          excerpt: clip(`★${row.rating} ${row.body ?? ''}`),
          href: `/finder?arcade=${row.arcade_id}`,
        }
      );
    }
    case 'chart_comment': {
      const row = await prisma.chart_comments.findUnique({
        where: { id },
        select: {
          player_id: true,
          body: true,
          charts: { select: { mode: true, level: true, songs: { select: { machine_id: true, title: true } } } },
        },
      });
      if (!row) return null;
      const chart = row.charts;
      const q = new URLSearchParams({ machineId: String(chart.songs.machine_id) });
      if (chart.mode) q.set('mode', chart.mode);
      const level = chart.level === null ? null : Number(chart.level);
      if (level !== null && Number.isInteger(level)) q.set('level', String(level));
      return { authorId: row.player_id, excerpt: clip(`[${chart.songs.title}] ${row.body}`), href: `/tier?${q}` };
    }
  }
}

// ─── 신고 ────────────────────────────────────────────────────

export class ReportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/**
 * 신고를 받습니다. 같은 사람이 같은 대상을 다시 신고하면 새 줄을 만들지 않고 `duplicate: true` 를
 * 돌려줍니다 — 화면은 "이미 신고했어요" 라고만 말하면 되고, 수가 부풀지 않습니다.
 */
export async function createContentReport(input: {
  reporterId: number;
  targetType: ReportTarget;
  targetId: number;
  reason: ReportReason;
  detail?: string | null;
}): Promise<{ duplicate: boolean }> {
  const target = await findTarget(input.targetType, input.targetId);
  if (!target) throw new ReportError('신고할 글을 찾지 못했어요. 이미 지워졌을 수 있습니다.', 404);
  if (target.authorId === input.reporterId) throw new ReportError('내가 쓴 글은 신고할 수 없어요.', 400);

  const prisma = await getPrismaClient();
  const detail = input.detail?.trim() ? input.detail.trim().slice(0, REPORT_DETAIL_MAX) : null;
  const { count } = await prisma.content_reports.createMany({
    data: [
      {
        reporter_id: input.reporterId,
        target_type: input.targetType,
        target_id: input.targetId,
        target_player_id: target.authorId,
        reason: input.reason,
        detail,
        excerpt: target.excerpt,
      },
    ],
    skipDuplicates: true,
  });
  return { duplicate: count === 0 };
}

/**
 * 신고함 — 대상마다 한 줄로 묶어서, 처리 전이면 신고 수가 많은 것부터.
 *
 * 묶기는 여기서 합니다. 신고는 하루 몇 건 규모라 한 쪽(최근 500건)을 읽어 메모리에서 묶어도
 * 충분하고, SQL 로 묶으면 사유별 수 · 설명 모으기가 길어집니다.
 */
export async function listReportGroups(status: ReportStatus): Promise<ReportGroup[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.content_reports.findMany({
    where: { status },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 500,
    select: {
      target_type: true,
      target_id: true,
      target_player_id: true,
      reason: true,
      detail: true,
      excerpt: true,
      created_at: true,
      reporter: { select: { nickname: true } },
      target_player: { select: { nickname: true } },
    },
  });

  const groups = new Map<string, ReportGroup>();
  for (const r of rows) {
    const key = `${r.target_type}:${r.target_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        targetType: r.target_type as ReportTarget,
        targetId: r.target_id,
        excerpt: r.excerpt,
        targetExists: false,
        href: null,
        author:
          r.target_player_id !== null && r.target_player
            ? { playerId: r.target_player_id, nickname: r.target_player.nickname }
            : null,
        status,
        count: 0,
        reasons: {},
        details: [],
        firstAt: r.created_at.toISOString(),
        lastAt: r.created_at.toISOString(),
      };
      groups.set(key, g);
    }
    g.count++;
    const reason = r.reason as ReportReason;
    g.reasons[reason] = (g.reasons[reason] ?? 0) + 1;
    if (r.detail && g.details.length < 5) g.details.push({ nickname: r.reporter.nickname, detail: r.detail });
    // 최신 순으로 읽으므로 처음 본 것이 lastAt, 마지막에 본 것이 firstAt
    g.firstAt = r.created_at.toISOString();
  }

  const list = [...groups.values()];
  // 대상이 아직 있는지 · 어디로 가는지 — 처리 전 목록만 봅니다(처리한 것은 대개 이미 지워졌습니다)
  if (status === 'open') {
    for (const g of list) {
      const t = await findTarget(g.targetType, g.targetId);
      g.targetExists = t !== null;
      g.href = t?.href ?? null;
    }
  }
  return list.sort((a, b) =>
    status === 'open' ? b.count - a.count || b.lastAt.localeCompare(a.lastAt) : b.lastAt.localeCompare(a.lastAt),
  );
}

/**
 * 한 대상에 모인 처리 전 신고를 한꺼번에 처리합니다.
 *
 *   'delete'  — 대상을 지우고(이미 없으면 그냥 넘어감) 신고를 '지움' 으로
 *   'dismiss' — 대상은 두고 신고를 '기각' 으로
 *
 * 두 번 불러도 결과가 같습니다(이미 처리된 신고는 다시 바꾸지 않음) — PUT 으로 엽니다.
 * 돌려주는 값은 이번에 처리한 신고 수입니다.
 */
export async function resolveReports(input: {
  targetType: ReportTarget;
  targetId: number;
  action: 'delete' | 'dismiss';
  adminId: number;
}): Promise<{ resolved: number; deleted: boolean }> {
  let deleted = false;
  if (input.action === 'delete') deleted = await deleteTarget(input.targetType, input.targetId);

  const prisma = await getPrismaClient();
  const { count } = await prisma.content_reports.updateMany({
    where: { target_type: input.targetType, target_id: input.targetId, status: 'open' },
    data: {
      status: input.action === 'delete' ? 'actioned' : 'dismissed',
      resolved_at: new Date(),
      resolved_by: input.adminId,
    },
  });
  return { resolved: count, deleted };
}

/** 대상을 지웁니다. 지웠으면 true, 이미 없었으면 false */
async function deleteTarget(type: ReportTarget, id: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  switch (type) {
    case 'post':
      return deletePostAsAdmin(id);
    case 'post_comment':
      return (await deleteCommentAsAdmin(id)) !== null;
    case 'arcade_review': {
      const row = await prisma.arcade_reviews.findUnique({ where: { id }, select: { arcade_id: true } });
      return row ? deleteReviewById(row.arcade_id, id) : false;
    }
    case 'chart_comment': {
      const { count } = await prisma.chart_comments.deleteMany({ where: { id } });
      return count > 0;
    }
  }
}

// ─── 차단 ────────────────────────────────────────────────────

export async function listBlocked(blockerId: number): Promise<BlockedPlayer[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.player_blocks.findMany({
    where: { blocker_id: blockerId },
    orderBy: { created_at: 'desc' },
    take: 500,
    select: { blocked_id: true, created_at: true, blocked: { select: { nickname: true } } },
  });
  return rows.map((r) => ({
    playerId: r.blocked_id,
    nickname: r.blocked.nickname,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * 차단을 **원하는 상태로** 맞춥니다 (GUIDELINES.md 4-1 — 뒤집지 않음).
 * 상대가 없거나 자기 자신이면 false.
 */
export async function setBlock(blockerId: number, blockedId: number, blocked: boolean): Promise<boolean> {
  if (blockerId === blockedId) return false;
  const prisma = await getPrismaClient();
  if (!blocked) {
    await prisma.player_blocks.deleteMany({ where: { blocker_id: blockerId, blocked_id: blockedId } });
    return true;
  }
  const exists = await prisma.players.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!exists) return false;
  await prisma.player_blocks.createMany({
    data: [{ blocker_id: blockerId, blocked_id: blockedId }],
    skipDuplicates: true,
  });
  return true;
}

// ─── 계정 정지 ───────────────────────────────────────────────

/**
 * 관리자 계정 목록 — 닉네임으로 찾거나(q), 없으면 처리 전 신고가 들어온 사람 · 정지 중인 사람 먼저.
 */
export async function listPlayersForAdmin(q: string | null): Promise<AdminPlayerRow[]> {
  const prisma = await getPrismaClient();
  const needle = q?.trim() ?? '';
  let ids: number[];
  if (needle !== '') {
    const asId = /^\d+$/.test(needle) ? Number(needle) : null;
    const rows = await prisma.players.findMany({
      where: {
        OR: [{ nickname: { contains: needle, mode: 'insensitive' } }, ...(asId ? [{ id: asId }] : [])],
      },
      orderBy: { id: 'asc' },
      take: 50,
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  } else {
    const reported = await prisma.content_reports.groupBy({
      by: ['target_player_id'],
      where: { status: 'open', target_player_id: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { target_player_id: 'desc' } },
      take: 50,
    });
    const suspended = await prisma.players.findMany({
      where: { suspended_until: { gt: new Date() } },
      orderBy: { suspended_until: 'desc' },
      take: 50,
      select: { id: true },
    });
    ids = [...new Set([...reported.map((r) => r.target_player_id!), ...suspended.map((r) => r.id)])];
  }
  if (ids.length === 0) return [];

  const players = await prisma.players.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      nickname: true,
      is_admin: true,
      created_at: true,
      suspended_until: true,
      suspended_reason: true,
      _count: { select: { posts: true, post_comments: true, arcade_reviews: true } },
    },
  });
  const open = await prisma.content_reports.groupBy({
    by: ['target_player_id'],
    where: { status: 'open', target_player_id: { in: ids } },
    _count: { _all: true },
  });
  const openOf = new Map(open.map((r) => [r.target_player_id, r._count._all]));
  const now = Date.now();
  const byId = new Map(
    players.map((p) => [
      p.id,
      {
        id: p.id,
        nickname: p.nickname,
        isAdmin: p.is_admin,
        createdAt: p.created_at.toISOString(),
        suspendedUntil:
          p.suspended_until && p.suspended_until.getTime() > now ? p.suspended_until.toISOString() : null,
        suspendedReason: p.suspended_until && p.suspended_until.getTime() > now ? p.suspended_reason : null,
        posts: p._count.posts,
        comments: p._count.post_comments,
        reviews: p._count.arcade_reviews,
        openReports: openOf.get(p.id) ?? 0,
      } satisfies AdminPlayerRow,
    ]),
  );
  // ids 의 순서(신고 많은 순 · 검색은 id 순)를 지킵니다
  return ids.map((id) => byId.get(id)).filter((r): r is AdminPlayerRow => r !== undefined);
}

export class SuspendError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

/**
 * 계정을 정지합니다. `days` 가 null 이면 무기한.
 *
 * 세대 번호(token_epoch)도 올립니다 — getSession 이 정지를 보고 막기는 하지만, 정지가 풀린 뒤에
 * 정지 전의 쿠키가 다시 살아나지 않게 합니다. 관리자 계정은 정지하지 않습니다(마지막 관리자가
 * 스스로를 잠그면 풀 사람이 없습니다).
 */
export async function suspendPlayer(input: {
  playerId: number;
  days: number | null;
  reason: string | null;
  now?: Date;
}): Promise<{ until: string }> {
  const prisma = await getPrismaClient();
  const row = await prisma.players.findUnique({ where: { id: input.playerId }, select: { is_admin: true } });
  if (!row) throw new SuspendError('그 계정을 찾을 수 없어요. 지워졌을 수 있어요', 404);
  if (row.is_admin) throw new SuspendError('관리자 계정은 정지할 수 없어요', 400);

  const until =
    input.days === null
      ? new Date(INDEFINITE_UNTIL)
      : new Date((input.now ?? new Date()).getTime() + input.days * 24 * 60 * 60 * 1000);
  await prisma.players.update({
    where: { id: input.playerId },
    data: {
      suspended_until: until,
      suspended_reason: input.reason?.trim() ? input.reason.trim().slice(0, 200) : null,
      token_epoch: { increment: 1 },
    },
  });
  return { until: until.toISOString() };
}

/** 정지를 풉니다. 없는 계정이면 false */
export async function unsuspendPlayer(playerId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.players.updateMany({
    where: { id: playerId },
    data: { suspended_until: null, suspended_reason: null },
  });
  return count > 0;
}

// ─── AI 기종 추정 검수 ───────────────────────────────────────

/** 검수 대기 중인 AI 추정 (lib/machine-guess.ts 가 쌓은 것) */
export async function listGuessesForReview(): Promise<GuessRow[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.arcade_machine_guesses.findMany({
    orderBy: [{ created_at: 'desc' }],
    take: 200,
    select: {
      arcade_id: true,
      machine_id: true,
      evidence: true,
      model: true,
      created_at: true,
      arcades: { select: { name: true, address: true } },
      machines: { select: { name: true } },
    },
  });
  const confirmed = await prisma.arcade_machines.findMany({
    where: { OR: rows.map((r) => ({ arcade_id: r.arcade_id, machine_id: r.machine_id })) },
    select: { arcade_id: true, machine_id: true },
  });
  const has = new Set(confirmed.map((c) => `${c.arcade_id}:${c.machine_id}`));
  return rows.map((r) => ({
    arcadeId: r.arcade_id,
    arcadeName: r.arcades.name,
    address: r.arcades.address,
    machineId: r.machine_id,
    machineName: r.machines.name,
    evidence: r.evidence,
    model: r.model,
    createdAt: r.created_at.toISOString(),
    alreadyConfirmed: has.has(`${r.arcade_id}:${r.machine_id}`),
  }));
}

/**
 * 추정을 확정합니다 — 보유 기종에 넣고(기체 1대) 추정 줄은 지웁니다.
 *
 * 이미 보유 기종이면 기체를 건드리지 않습니다(제보로 쌓인 컨디션이 기체 id 에 붙어 있습니다 —
 * lib/arcades.ts replaceMachines 주석). 추정 줄이 없으면 false.
 */
export async function approveGuess(arcadeId: number, machineId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const guess = await prisma.arcade_machine_guesses.findUnique({
    where: { arcade_id_machine_id: { arcade_id: arcadeId, machine_id: machineId } },
    select: { arcade_id: true },
  });
  if (!guess) return false;
  // 기종이 리듬게임 목록에 아직 있는지 — 관리자가 그 사이 기종을 뺐으면 넣지 않습니다
  if (!(await listMachines()).some((m) => m.id === machineId)) return false;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.arcade_machines.findUnique({
      where: { arcade_id_machine_id: { arcade_id: arcadeId, machine_id: machineId } },
      select: { arcade_id: true },
    });
    if (!existing) {
      await tx.arcade_machines.create({ data: { arcade_id: arcadeId, machine_id: machineId } });
      await tx.arcade_cabinets.create({ data: { arcade_id: arcadeId, machine_id: machineId, cabinet_no: 1 } });
    }
    await tx.arcade_machine_guesses.delete({
      where: { arcade_id_machine_id: { arcade_id: arcadeId, machine_id: machineId } },
    });
  });
  return true;
}

/** 추정을 버립니다. 없으면 false */
export async function rejectGuess(arcadeId: number, machineId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.arcade_machine_guesses.deleteMany({
    where: { arcade_id: arcadeId, machine_id: machineId },
  });
  return count > 0;
}
