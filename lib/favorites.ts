import { getPrismaClient } from './prisma';

/**
 * 즐겨찾기 — "내가 담아 둔 오락실".
 *
 * 리뷰·제보와 달리 담을 값이 없습니다(별을 눌렀다는 사실뿐). 그래서 여기서는
 * **id 목록만** 오갑니다 — 화면은 이 집합으로 별을 칠하고, 목록에서 담아 둔 곳을
 * 맨 위로 당깁니다 (lib/recommend.ts favoritesFirst).
 *
 * 목록 순서는 최근에 담은 순입니다. 지금은 화면이 집합으로만 쓰지만, 순서를
 * 정해 두지 않으면 나중에 "최근에 담은 곳" 을 보여 줄 때 근거가 없습니다.
 */

export async function listFavoriteIds(playerId: number): Promise<number[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.arcade_favorites.findMany({
    where: { player_id: playerId },
    orderBy: [{ created_at: 'desc' }, { arcade_id: 'desc' }],
    select: { arcade_id: true },
  });
  return rows.map((r) => r.arcade_id);
}

/**
 * 담기. 이미 담아 둔 곳이면 아무 일도 하지 않습니다 — 별을 두 번 눌러
 * 에러를 보게 할 이유가 없습니다 (`skipDuplicates` = ON CONFLICT DO NOTHING).
 *
 * 없는 오락실·없는 플레이어면 FK 위반이 그대로 올라갑니다.
 * 라우트가 그걸 404 로 바꿉니다 (lib/pg-errors.ts).
 */
export async function addFavorite(playerId: number, arcadeId: number): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.arcade_favorites.createMany({
    data: [{ player_id: playerId, arcade_id: arcadeId }],
    skipDuplicates: true,
  });
}

/** 빼기. 담아 두지 않았던 곳이면 false — 라우트는 그래도 성공으로 답합니다 */
export async function removeFavorite(playerId: number, arcadeId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.arcade_favorites.deleteMany({
    where: { player_id: playerId, arcade_id: arcadeId },
  });
  return count > 0;
}
