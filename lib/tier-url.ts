import { UNKNOWN_LEVEL } from './tier-types';

/**
 * 서열표 주소 ↔ 화면 상태 (UX 시험 2026-11-20 C-1).
 *
 *   /tier?machineId=1&mode=S&level=20&chart=123
 *
 * 게임 · 버전 · 모드 · 레벨이 표를, `chart` 가 열린 채보 패널을 가리킵니다. 주소만으로 같은
 * 화면이 다시 서야 새로고침 · 공유 · 뒤로 가기가 모두 맞습니다. 순수 함수라 화면과 테스트가
 * 같이 씁니다.
 */

export interface TierSelection {
  machineId: number | null;
  versionId: number | null;
  mode: string | null;
  /**
   * 숫자 = 그 레벨 · `UNKNOWN_LEVEL` = 난이도 미상 칸 · null = 서버가 고른다.
   * '고르지 않음' 과 '모름' 은 다른 뜻이라 null 하나로 합칠 수 없습니다.
   */
  level: number | typeof UNKNOWN_LEVEL | null;
}

export interface TierUrlState {
  sel: TierSelection;
  /** 열린 채보. 없으면 null */
  chartId: number | null;
}

/**
 * 주소의 쿼리를 읽는다. 값이 이상하면(정수가 아니면) null 로 둡니다 — null 은 "서버가
 * 알아서 고르라" 는 뜻이라, 주소를 손으로 고쳐도 화면이 깨지지 않고 기본 조합으로 갑니다.
 * 채보 번호는 양의 정수만 받습니다.
 */
export function parseTierQuery(search: string): TierUrlState {
  const q = new URLSearchParams(search);
  const int = (key: string): number | null => {
    const raw = q.get(key);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  };
  const chart = int('chart');
  return {
    sel: {
      machineId: int('machineId'),
      versionId: int('versionId'),
      mode: q.get('mode') || null,
      level: q.get('level') === UNKNOWN_LEVEL ? UNKNOWN_LEVEL : int('level'),
    },
    chartId: chart !== null && chart > 0 ? chart : null,
  };
}

/**
 * 화면 상태 → 쿼리 문자열 (앞의 `?` 없음). 비어 있는 칸은 적지 않습니다 — 버전이 없는
 * 게임에 빈 `versionId=`, 모드가 없는 게임에 빈 `mode=` 를 남기지 않습니다.
 * 순서는 늘 같아서, 같은 상태면 같은 주소가 나옵니다 (중복 기록을 거르는 비교에 씀).
 */
export function tierQuery(state: TierUrlState): string {
  const q = new URLSearchParams();
  const { sel, chartId } = state;
  if (sel.machineId !== null) q.set('machineId', String(sel.machineId));
  if (sel.versionId !== null) q.set('versionId', String(sel.versionId));
  if (sel.mode !== null) q.set('mode', sel.mode);
  if (sel.level !== null) q.set('level', String(sel.level));
  if (chartId !== null) q.set('chart', String(chartId));
  return q.toString();
}

/** 두 선택이 같은 표를 요청하는가 — 같으면 다시 불러오지 않습니다 */
export function sameSelection(a: TierSelection, b: TierSelection): boolean {
  return (
    a.machineId === b.machineId &&
    a.versionId === b.versionId &&
    a.mode === b.mode &&
    a.level === b.level
  );
}
