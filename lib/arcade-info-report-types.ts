/**
 * 오락실 정보 고침 제보의 모양 · 문구 (db/migrate-087-arcade-info-reports.sql).
 *
 * 화면(components/ArcadeInfoReport.tsx · app/admin)과 서버(lib/arcade-info-reports.ts)가 같이 씁니다.
 * DB 를 물지 않습니다 — 클라이언트 번들에 들어갑니다.
 */

export const ARCADE_INFO_KINDS = ['hours', 'closed', 'moved', 'other'] as const;
export type ArcadeInfoKind = (typeof ARCADE_INFO_KINDS)[number];

/** 영업시간 문장 상한 — DB CHECK 와 같습니다 */
export const INFO_HOURS_MAX = 200;
/** 설명 상한 — DB CHECK 와 같습니다 */
export const INFO_DETAIL_MAX = 300;

/** 고르는 칸의 이름 (해요체 · 쉬운 말) */
export const ARCADE_INFO_KIND_LABEL: Record<ArcadeInfoKind, string> = {
  hours: '영업시간이 달라요',
  closed: '문을 닫았어요',
  moved: '다른 곳으로 옮겼어요',
  other: '다른 정보가 달라요',
};

/** 관리자 화면에서 줄 앞에 붙는 짧은 이름 */
export const ARCADE_INFO_KIND_SHORT: Record<ArcadeInfoKind, string> = {
  hours: '영업시간',
  closed: '문 닫음',
  moved: '옮김',
  other: '그 밖',
};

/** 종류마다 무엇을 받아야 하는지 — 화면과 서버(zod)가 같은 규칙을 봅니다 */
export function infoFieldsOf(kind: ArcadeInfoKind): { hours: boolean; detail: 'required' | 'optional' } {
  switch (kind) {
    case 'hours':
      return { hours: true, detail: 'optional' };
    case 'closed':
      return { hours: false, detail: 'optional' };
    default:
      return { hours: false, detail: 'required' };
  }
}

/** 보낸 뒤 그 자리에 띄울 말 — 바로 바뀌지 않는다는 것을 함께 알립니다 */
export function infoSentMessage(kind: ArcadeInfoKind, updated: boolean): string {
  const head = updated ? '알려 주신 내용을 고쳤어요.' : '알려 주셔서 고마워요.';
  return kind === 'hours'
    ? `${head} 확인한 뒤 영업시간에 반영할게요.`
    : `${head} 확인한 뒤 오락실 정보를 고칠게요.`;
}

/** 관리자 검수 목록 한 줄 */
export interface ArcadeInfoReportRow {
  id: number;
  arcadeId: number;
  arcadeName: string;
  address: string;
  /** 지금 화면에 보이는 영업시간 (비교용) */
  currentHours: string | null;
  kind: ArcadeInfoKind;
  hoursText: string | null;
  detail: string | null;
  nickname: string;
  createdAt: string;
}
