import { describe, expect, it } from 'vitest';
import { MARKER_MACHINE_NAMES, machineSummary, machineTooltip } from '@/lib/machine-summary';

/**
 * 지도 이름표의 기종 표시. 여기 못 박는 것:
 *   - 숫자만 붙이지 않는다 ("어뮤즈타운 0" 은 읽히지 않았다 — 2026-10-22)
 *   - 필터가 없으면 단위를 붙인 종 수, 필터를 켜면 그 게임과 대수 — 알약이 늘 짧다
 *   - 전체 목록은 툴팁으로만, 이름표가 이미 다 말했으면 툴팁도 없다
 */

let seq = 0;
const m = (shortName: string, opts: { name?: string; cabinets?: number; id?: number } = {}) => ({
  id: opts.id ?? ++seq,
  shortName,
  name: opts.name ?? shortName,
  cabinetCount: opts.cabinets ?? 1,
});

const LINEUP = [
  m('펌프', { id: 1, cabinets: 3 }),
  m('태고', { id: 2 }),
  m('사볼', { id: 3, cabinets: 2 }),
  m('IIDX', { id: 4 }),
  m('maimai', { id: 5 }),
];

describe('machineSummary — 필터 없음', () => {
  it('등록된 기종이 없으면 null — "0종" 을 붙이지 않는다', () => {
    expect(machineSummary([])).toBeNull();
  });

  it('몇 종이 있는지 단위를 붙여 말한다 — 기종이 늘어도 알약 길이가 같다', () => {
    expect(machineSummary([m('펌프')])).toBe('1종');
    expect(machineSummary(LINEUP)).toBe('5종');
  });
});

describe('machineSummary — 필터 켬', () => {
  it('켜 둔 게임과 그 대수만 적는다', () => {
    expect(machineSummary(LINEUP, [3])).toBe('사볼 2대');
  });

  it('여럿 켰으면 원래 순서대로 — 고른 순서로 흔들리지 않는다', () => {
    expect(machineSummary(LINEUP, [5, 3])).toBe('사볼 2대 · maimai 1대');
  });

  it(`${MARKER_MACHINE_NAMES}개를 넘게 켰으면 나머지는 "외 N"`, () => {
    expect(machineSummary(LINEUP, [1, 3, 5])).toBe('펌프 3대 · 사볼 2대 외 1');
  });

  it('켜 둔 게임이 이 오락실에 없으면 종 수로 물러선다 (선택해 둔 곳은 조건 밖이어도 지도에 남는다)', () => {
    expect(machineSummary(LINEUP, [99])).toBe('5종');
  });

  it('줄임말이 비어 있으면 정식 명칭을 쓴다', () => {
    expect(machineSummary([m('', { id: 7, name: 'DanceDanceRevolution' })], [7])).toBe(
      'DanceDanceRevolution 1대',
    );
  });
});

describe('machineTooltip', () => {
  it('기종이 없으면 툴팁도 없다', () => {
    expect(machineTooltip([])).toBeNull();
  });

  it('필터가 없으면 전부를 대수와 함께', () => {
    expect(machineTooltip(LINEUP)).toBe('보유 기종 5종 — 펌프 ×3 · 태고 · 사볼 ×2 · IIDX · maimai');
  });

  it('필터를 켰으면 그 게임이 앞', () => {
    expect(machineTooltip(LINEUP, [3])).toBe('보유 기종 5종 — 사볼 ×2 · 펌프 ×3 · 태고 · IIDX · maimai');
  });

  it('이름표가 이미 전부를 말했으면 툴팁이 없다 — 같은 말을 두 번 띄우지 않는다', () => {
    const two = [m('펌프', { id: 21, cabinets: 3 }), m('태고', { id: 22 })];
    expect(machineTooltip(two, [21, 22])).toBeNull();
  });
});
