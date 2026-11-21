/**
 * 신고 · 차단 · 계정 정지 · AI 기종 추정 검수의 공용 타입과 문구.
 *
 * 서버 모듈(lib/moderation.ts)은 Prisma 를 끌고 오므로 화면에서 import 할 수 없습니다.
 * 화면과 API 가 같은 말을 쓰도록 순수 값만 모읍니다 (lib/chat-types.ts 와 같은 규칙).
 */

/** 신고할 수 있는 것 — db/migrate-083 의 CHECK 와 같은 목록 */
export const REPORT_TARGETS = ['post', 'post_comment', 'arcade_review', 'chart_comment'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_TARGET_LABEL: Record<ReportTarget, string> = {
  post: '게시글',
  post_comment: '댓글',
  arcade_review: '오락실 리뷰',
  chart_comment: '채보 평가',
};

export const REPORT_REASONS = ['spam', 'abuse', 'privacy', 'false_info', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: '광고 · 도배',
  abuse: '욕설 · 비방',
  privacy: '개인정보 노출',
  false_info: '거짓 정보',
  other: '기타',
};

/** 신고에 덧붙이는 설명의 최대 길이 — migrate-083 의 CHECK 와 같다 */
export const REPORT_DETAIL_MAX = 500;

export type ReportStatus = 'open' | 'actioned' | 'dismissed';

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: '처리 전',
  actioned: '지움',
  dismissed: '기각',
};

/**
 * 신고함의 한 줄 — **대상 하나**에 모인 신고를 묶은 것.
 *
 * 같은 글을 다섯 명이 신고하면 다섯 줄이 아니라 한 줄에 5건으로 보여야 무엇이 급한지 보입니다.
 */
export interface ReportGroup {
  targetType: ReportTarget;
  targetId: number;
  /** 신고 당시 남긴 발췌. 대상이 지워져도 남습니다 */
  excerpt: string | null;
  /** 대상이 아직 있는지 — 없으면 '지우기' 대신 '처리 완료' 만 남습니다 */
  targetExists: boolean;
  /** 화면에서 그 대상으로 가는 주소 (없으면 null) */
  href: string | null;
  author: { playerId: number; nickname: string } | null;
  status: ReportStatus;
  count: number;
  reasons: Partial<Record<ReportReason, number>>;
  /** 덧붙인 설명들 (최신 순, 최대 5개) */
  details: { nickname: string; detail: string }[];
  firstAt: string;
  lastAt: string;
}

/** 관리자 계정 목록의 한 줄 */
export interface AdminPlayerRow {
  id: number;
  nickname: string;
  isAdmin: boolean;
  createdAt: string;
  suspendedUntil: string | null;
  suspendedReason: string | null;
  posts: number;
  comments: number;
  reviews: number;
  /** 이 사람이 쓴 것에 들어온 처리 전 신고 수 */
  openReports: number;
}

/** 정지 기간 고르기 — 일 수. null = 무기한 */
export const SUSPEND_OPTIONS: { days: number | null; label: string }[] = [
  { days: 1, label: '1일' },
  { days: 7, label: '7일' },
  { days: 30, label: '30일' },
  { days: null, label: '무기한' },
];

/** 무기한 정지를 DB 에 적을 때의 시각 — NULL 은 "정지 아님" 이라 먼 미래로 둡니다 */
export const INDEFINITE_UNTIL = '9999-12-31T00:00:00.000Z';

export function isIndefinite(until: string | null): boolean {
  return until !== null && new Date(until).getUTCFullYear() >= 9999;
}

/** AI 기종 추정 검수 목록의 한 줄 */
export interface GuessRow {
  arcadeId: number;
  arcadeName: string;
  address: string;
  machineId: number;
  machineName: string;
  evidence: string;
  model: string;
  createdAt: string;
  /** 이미 보유 기종으로 확정돼 있는지 — 그러면 승인할 것이 없습니다 */
  alreadyConfirmed: boolean;
}

/** 내가 차단한 사람 */
export interface BlockedPlayer {
  playerId: number;
  nickname: string;
  createdAt: string;
}
/** 정지 기간을 사람 말로 — `7일` · `무기한` */
export function suspendLabel(days: number | null): string {
  return days === null ? '무기한' : `${days}일`;
}

/** 정지 확인 문구 (UX 시험 Ad-2 — 사유 없이 · 확인 없이 정지되던 것) */
export function suspendConfirmText(nickname: string, days: number | null, reason: string): string {
  const what = days === null ? '무기한 정지할까요?' : `${days}일 정지할까요?`;
  return `${nickname} 님을 ${what}\n사유: ${reason}\n\n바로 로그아웃되고, 다시 로그인하면 이 사유를 봐요.`;
}

/** 정지 풀기 확인 문구 (Ad-3 — 정지 직후 같은 자리 단추로 실수로 풀리던 것) */
export function unsuspendConfirmText(nickname: string): string {
  return `${nickname} 님의 정지를 풀까요?\n바로 다시 로그인하고 글을 쓸 수 있어요.`;
}

