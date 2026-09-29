import type { ArcadeReview } from './community-types';
import { recalcArcadeRating } from './typed-sql';
import { getPrismaClient, iso } from './prisma';

/**
 * 오락실 리뷰 / 평점.
 *
 * 1인 1리뷰(UNIQUE)로 두고 수정은 UPSERT 로 처리합니다. 여러 건을 허용하면
 * 같은 사람이 평점을 반복해 얹어 평균을 끌어올릴 수 있고, 그걸 막으려면
 * 결국 애플리케이션에서 같은 제약을 다시 구현해야 합니다.
 */

const reviewInclude = { players: { select: { nickname: true } } } as const;

type ReviewRow = {
  id: number;
  arcade_id: number;
  player_id: number;
  rating: number;
  body: string | null;
  created_at: Date;
  updated_at: Date;
  players: { nickname: string };
};

function toReview(r: ReviewRow): ArcadeReview {
  return {
    id: r.id,
    arcadeId: r.arcade_id,
    playerId: r.player_id,
    nickname: r.players.nickname,
    rating: r.rating,
    body: r.body ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function listReviews(arcadeId: number): Promise<ArcadeReview[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.arcade_reviews.findMany({
    where: { arcade_id: arcadeId },
    orderBy: { created_at: 'desc' },
    include: reviewInclude,
  });
  return rows.map(toReview);
}

/**
 * 평점 캐시(arcades.rating_avg / review_count) 갱신. 리뷰가 바뀔 때마다 호출.
 * 집계는 DB 함수(recalc_arcade_rating)가 합니다 — prisma/sql/recalcArcadeRating.sql.
 */
async function recalc(arcadeId: number): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.$queryRawTyped(recalcArcadeRating(arcadeId));
}

export async function upsertReview(input: {
  arcadeId: number;
  playerId: number;
  rating: number;
  body: string | null;
}): Promise<ArcadeReview> {
  const prisma = await getPrismaClient();
  const row = await prisma.arcade_reviews.upsert({
    where: { arcade_id_player_id: { arcade_id: input.arcadeId, player_id: input.playerId } },
    create: {
      arcade_id: input.arcadeId,
      player_id: input.playerId,
      rating: input.rating,
      body: input.body,
    },
    update: { rating: input.rating, body: input.body, updated_at: new Date() },
    include: reviewInclude,
  });
  await recalc(input.arcadeId);
  await dropSummary(input.arcadeId);
  return toReview(row);
}

export async function deleteReview(arcadeId: number, playerId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.arcade_reviews.deleteMany({
    where: { arcade_id: arcadeId, player_id: playerId },
  });
  await recalc(arcadeId);
  await dropSummary(arcadeId);
  return count > 0;
}

/**
 * 리뷰가 바뀌었으니 AI 요약 캐시를 버립니다 (db/migrate-073-review-summaries.sql).
 *
 * lib/review-summary.ts 를 import 하지 않고 직접 지웁니다 — 그쪽이 이 파일의
 * listReviews 를 쓰므로 서로 import 하면 순환이 됩니다. 다음에 상세를 여는 사람이
 * 새 요약을 만듭니다(GET /api/arcades/:id/reviews/summary).
 */
async function dropSummary(arcadeId: number): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.arcade_review_summaries.deleteMany({ where: { arcade_id: arcadeId } });
}
