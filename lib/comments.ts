import type { ChartComment } from './community-types';
import { getPrismaClient, iso } from './prisma';

/**
 * 채보 평가.
 *
 * difficulty_votes 와 분리된 이유: 투표는 "얼마나 어렵냐"는 스칼라 하나이고,
 * 평가는 "왜 어렵냐"입니다. 서열표에서 등급만 보고 골랐다가 막히는 건 대개
 * 후자 때문입니다 (틀기 약한 사람에게 틀기 채보, 체력 없는 사람에게 롱런).
 *
 * 투표와 달리 클리어 게이트를 걸지 않습니다 — 못 깬 사람의 "여기서 막힌다" 도
 * 정보이기 때문입니다. 대신 목록에 클리어 여부를 함께 실어 보냅니다.
 */

/**
 * 한 줄에 필요한 관계. 투표값(difficulty_votes.value)은 일부러 싣지 않는다 —
 * 투표 분포를 익명으로 두기로 한 결정이 평가란을 통해 뚫리면 안 된다. 클리어 여부만
 * 내보낸다 (작성자의 clear_records 중 **이 채보** 것만 골라 있는지 본다).
 */
const commentInclude = (chartId: number) =>
  ({
    players: {
      select: {
        nickname: true,
        clear_records: { where: { chart_id: chartId }, select: { chart_id: true } },
      },
    },
  }) as const;

type CommentRow = {
  id: number;
  chart_id: number;
  player_id: number;
  body: string;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  players: { nickname: string; clear_records: { chart_id: number }[] };
};

function toComment(r: CommentRow): ChartComment {
  return {
    id: r.id,
    chartId: r.chart_id,
    playerId: r.player_id,
    nickname: r.players.nickname,
    body: r.body,
    tags: r.tags,
    cleared: r.players.clear_records.length > 0,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function listComments(chartId: number): Promise<ChartComment[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.chart_comments.findMany({
    where: { chart_id: chartId },
    orderBy: { created_at: 'desc' },
    include: commentInclude(chartId),
  });
  return rows.map(toComment);
}

export async function upsertComment(input: {
  chartId: number;
  playerId: number;
  body: string;
  tags: string[];
}): Promise<ChartComment> {
  const prisma = await getPrismaClient();
  const row = await prisma.chart_comments.upsert({
    where: { chart_id_player_id: { chart_id: input.chartId, player_id: input.playerId } },
    create: { chart_id: input.chartId, player_id: input.playerId, body: input.body, tags: input.tags },
    update: { body: input.body, tags: input.tags, updated_at: new Date() },
    include: commentInclude(input.chartId),
  });
  return toComment(row);
}

export async function deleteComment(chartId: number, playerId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.chart_comments.deleteMany({
    where: { chart_id: chartId, player_id: playerId },
  });
  return count > 0;
}
