import { getPrismaClient } from './prisma';

/**
 * 막 만든 계정이 지도·서열표·평점의 근거를 흔들지 못하게 하는 기준.
 *
 * 가입은 실패한 시도만 세서 막고 성공한 가입에는 횟수 제한이 없습니다
 * (app/api/auth/signup). 그래서 일회용 계정을 몇 개든 만들 수 있고, 2026-10-28 QA 에서
 * 방금 만든 계정 하나가
 *   - "클리어했습니다" 체크 한 번 뒤 투표 1표로 펌프 S20 채보를 '상' → '개인차' 로 옮겼고
 *   - 별 5개 리뷰 1건으로 오락실 목록(평점 높은 순)의 1위가 됐습니다.
 *
 * 있어요/없어졌어요 제보는 2026-09-13 부터 같은 기준으로 세지 않습니다
 * (lib/reports.ts applyPresence). 투표·특수 패턴·리뷰는 **받지 않습니다** — 제보처럼
 * "남기되 세지 않기" 로 하면 서열·평점 집계(DB 함수)를 고쳐야 하고, 내 표는 보이는데
 * 등급은 그대로인 화면이 됩니다. 막힌 이유는 남은 시간과 함께 그대로 말합니다.
 */

/** 가입 후 이 시간이 지나야 표·평점이 됩니다 */
export const MIN_ACCOUNT_AGE_HOURS = 24;

const MIN_ACCOUNT_AGE_MS = MIN_ACCOUNT_AGE_HOURS * 60 * 60 * 1000;

/** 가입 시각으로 본 남은 대기 시간(ms). 다 지났으면 0 */
export function accountAgeWaitMs(createdAt: Date, now: number = Date.now()): number {
  return Math.max(0, createdAt.getTime() + MIN_ACCOUNT_AGE_MS - now);
}

/** 그 플레이어가 아직 기다려야 하는 시간(ms). 계정을 못 찾으면 0 — 세션은 호출부가 이미 확인했습니다 */
export async function playerAccountWaitMs(playerId: number): Promise<number> {
  const prisma = await getPrismaClient();
  const row = await prisma.players.findUnique({
    where: { id: playerId },
    select: { created_at: true },
  });
  return row ? accountAgeWaitMs(row.created_at) : 0;
}

/**
 * 막힌 이유를 사람 말로. `action` 은 "투표할" 처럼 '수 있습니다' 앞에 오는 말,
 * `target` 은 "서열이" 처럼 조사까지 붙인 말입니다.
 */
export function newAccountMessage(action: string, target: string, waitMs: number): string {
  const hours = Math.max(1, Math.ceil(waitMs / (60 * 60 * 1000)));
  return (
    `가입 후 ${MIN_ACCOUNT_AGE_HOURS}시간이 지나야 ${action} 수 있습니다 (약 ${hours}시간 남음). ` +
    `막 만든 계정으로 ${target} 흔들리지 않게 하려는 제한입니다`
  );
}
