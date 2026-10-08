/**
 * 운영 알림 — 화면(components/OpsAlertBell.tsx)과 서버가 같이 쓰는 모양.
 *
 * 서버 모듈(Prisma · Gemini · web-push)을 끌고 오지 않습니다. 화면 번들에 들어갑니다.
 */

export type OpsAlertStatus = 'firing' | 'resolved';

/** 먼저 볼 것 한 줄. 서버에서 칠 명령이 있으면 command 에 따로 — 화면이 복사 단추를 붙입니다 */
export interface OpsAlertCheck {
  what: string;
  command: string | null;
}

/** Gemini 가 만든 요약 (lib/ops-alert-summary.ts) */
export interface OpsAlertAi {
  /** 무슨 일인지 한 줄 — 푸시 알림의 제목 뒤에도 씁니다 */
  headline: string;
  /** 사용자에게 미치는 영향 */
  impact: string;
  causes: string[];
  checks: OpsAlertCheck[];
}

export interface OpsAlertView {
  id: number;
  status: OpsAlertStatus;
  /** 규칙 이름 (DiskLow 등) */
  alertname: string;
  severity: string | null;
  /** 규칙에 적힌 설명 — 요약이 없을 때 대신 보여 줍니다 */
  summary: string | null;
  startsAt: string;
  endsAt: string | null;
  updatedAt: string;
  read: boolean;
  ai: OpsAlertAi | null;
  /** 요약을 만들지 못한 까닭 (키 없음 · 한도 · 모델 오류). 만드는 중이면 ai · aiError 둘 다 null */
  aiError: string | null;
  /** Grafana 의 규칙 화면 */
  grafanaUrl: string | null;
}

/** GET /api/ops/alerts */
export interface OpsAlertsResponse {
  alerts: OpsAlertView[];
  /** 아직 열어 보지 않은 것 (울림 · 풀림 모두) */
  unread: number;
  /** 서버에 푸시 키가 있어 기기 알림을 켤 수 있는가 */
  pushReady: boolean;
}

/** 목록에 보여 주는 최근 알림 수 */
export const OPS_ALERTS_LIST_LIMIT = 30;

/**
 * 알림을 누르면 열 주소. 화면이 이 쿼리를 보면 알림 패널을 엽니다.
 * 서비스 워커(public/sw.js)와 이 값이 같아야 합니다 — 테스트가 맞춰 봅니다.
 */
export const OPS_OPEN_PARAM = 'ops';
export const OPS_OPEN_URL = `/?${OPS_OPEN_PARAM}=open`;

/** "3분 전" 같은 상대 시각 — 패널과 푸시 본문이 씁니다 */
export function ago(iso: string, now: number = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 60) return '방금';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.round(hour / 24)}일 전`;
}

/** 울린 뒤 풀리기까지 걸린 시간 — "12분" · "3시간 5분" */
export function lasted(startsAt: string, endsAt: string): string {
  const min = Math.max(0, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000));
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}
