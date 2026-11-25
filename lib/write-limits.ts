import { tooMany } from './api-errors';
import { consume, HOUR_MS, limitFromEnv, retryAfterLabel } from './rate-limit';

/**
 * 글 · 댓글을 한 사람이 한 시간에 쓸 수 있는 수 (2026-11-25, SSOT R28 의 일부).
 *
 * 전에는 상한이 없어 계정 하나로 도배하면 그대로 쌓였습니다. 글이 늘면 게시판 검색 ·
 * 챗봇 search_posts 가 그 글을 읽으므로, 도배가 곧 AI 입력 분량과 운영자 검토 분량이
 * 됩니다. 사람이 손으로 쓰는 속도로는 닿지 않을 값으로 잡았습니다 — 막는 대상은 스크립트입니다.
 *
 * 리뷰 · 채보 평가는 한 사람이 대상마다 하나(덮어쓰기)라 여기서 세지 않습니다.
 * 오락실 정보 고침 제보(info)도 같은 이유로 거의 쌓이지 않지만, 오락실을 바꿔 가며 보낼 수 있어 셉니다.
 * 운영 중 조정은 환경변수로 (배포 없이).
 */
export const WRITE_LIMITS = {
  post: { key: 'post', perHour: limitFromEnv('POST_HOURLY_LIMIT', 10), noun: '글' },
  comment: { key: 'comment', perHour: limitFromEnv('COMMENT_HOURLY_LIMIT', 60), noun: '댓글' },
  /** 오락실 정보 고침 제보 (migrate-087) — 관리자가 하나씩 읽으므로 넉넉할 필요가 없습니다 */
  info: { key: 'info', perHour: limitFromEnv('INFO_REPORT_HOURLY_LIMIT', 10), noun: '정보 고침 제보' },
} as const;

export type WriteKind = keyof typeof WRITE_LIMITS;

/**
 * 한 번 셉니다. 넘었으면 429 응답을, 아니면 null 을 돌려줍니다.
 * 입력 검사를 통과한 요청에만 부르세요 — 400 으로 튕길 요청까지 세면 고쳐 쓰는 사람이 막힙니다.
 */
export async function checkWriteLimit(kind: WriteKind, playerId: number) {
  const { key, perHour, noun } = WRITE_LIMITS[kind];
  const r = await consume(`write:${key}:player:${playerId}`, perHour, HOUR_MS);
  if (r.allowed) return null;
  return tooMany(
    `한 시간에 ${noun}${kind === 'info' ? '는' : '은'} ${r.limit}개까지 쓸 수 있어요. ${retryAfterLabel(r.retryAfterMs)} 뒤에 다시 써 주세요.`,
    r.retryAfterMs,
  );
}
