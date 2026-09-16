import { describe, expect, it } from 'vitest';
import { parseLevelNotation } from '@/lib/chart-sources';

/**
 * 난이도 표기 해석 — 여기가 틀리면 **곡이 엉뚱한 층에 박힙니다.**
 *
 * 서열표는 층 단위로 묶어 보여주는 화면이라, 13+ 가 13 으로 들어가면 사용자가
 * 잘못된 비교를 보게 됩니다. 그리고 한 번 들어간 뒤에는 투표가 쌓여서 되돌리기가
 * 어렵습니다 — 넣기 전에 막아야 하는 종류의 오류입니다.
 */
describe('parseLevelNotation — 정수', () => {
  it('숫자는 그대로, 이름도 그대로', () => {
    expect(parseLevelNotation('12')).toEqual({ level: 12, label: '12' });
    expect(parseLevelNotation('1')).toEqual({ level: 1, label: '1' });
  });

  it('pop’n 처럼 30 을 넘는 값도 받는다 (예전 CHECK 가 막던 자리)', () => {
    expect(parseLevelNotation('50')).toEqual({ level: 50, label: '50' });
  });
});

describe('parseLevelNotation — 플러스 표기', () => {
  it('13+ 는 13 과 14 사이에 서고, 이름은 13+ 로 남는다', () => {
    expect(parseLevelNotation('13+')).toEqual({ level: 13.5, label: '13+' });
  });

  it('13 과 13+ 는 서로 다른 층이다 — 같은 값으로 뭉개지면 안 된다', () => {
    const plain = parseLevelNotation('13')!;
    const plus = parseLevelNotation('13+')!;
    expect(plain.label).not.toBe(plus.label);
    expect(plain.level).toBeLessThan(plus.level);
    expect(plus.level).toBeLessThan(parseLevelNotation('14')!.level);
  });
});

describe('parseLevelNotation — 소수 표기', () => {
  it('jubeat·기타도라의 소수는 값도 이름도 그대로', () => {
    expect(parseLevelNotation('10.9')).toEqual({ level: 10.9, label: '10.9' });
    expect(parseLevelNotation('9.99')).toEqual({ level: 9.99, label: '9.99' });
  });

  it('10.3 과 10.7 이 한 칸에 뭉치지 않는다', () => {
    expect(parseLevelNotation('10.3')!.level).not.toBe(parseLevelNotation('10.7')!.level);
  });
});

describe('parseLevelNotation — 값이 없는 칸', () => {
  /**
   * 그 난이도가 아예 없는 곡입니다 (Re:MASTER 가 없는 곡처럼). 0 이나 1 로 넣으면
   * **없는 채보가 1레벨로 생겨** 목록을 오염시킵니다. null 이어야 호출부가 건너뜁니다.
   */
  it('빈 값 · 하이픈 · 공백은 null', () => {
    for (const v of ['', '   ', '-']) expect(parseLevelNotation(v)).toBeNull();
  });

  it('문자열이 아닌 것도 null (필드 자체가 없는 곡)', () => {
    for (const v of [undefined, null, 12, {}]) expect(parseLevelNotation(v)).toBeNull();
  });

  it('숫자로 읽을 수 없으면 null — 조용히 0 으로 만들지 않는다', () => {
    for (const v of ['???', 'N/A', '＋', '0', '0+']) expect(parseLevelNotation(v)).toBeNull();
  });
});

describe('parseLevelNotation — 주변 공백', () => {
  it('앞뒤 공백은 떼고 이름에도 남기지 않는다', () => {
    expect(parseLevelNotation(' 13+ ')).toEqual({ level: 13.5, label: '13+' });
  });
});
