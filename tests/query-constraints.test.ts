import { describe, expect, it } from 'vitest';
import {
  extractConstraints,
  findMentionedArcade,
  findMentionedMachines,
  findPlaceQuery,
} from '@/lib/query-constraints';
import type { Arcade, Machine } from '@/lib/types';

/**
 * 오인식은 그 오락실을 **결과에서 빼 버리므로** 미탐보다 훨씬 나쁩니다.
 * 여기 못 박는 것: 확실할 때만 잡고, 모호하면 null 로 물러선다.
 */

const arcade = (id: number, name: string): Arcade => ({
  id,
  name,
  address: '',
  lat: 37.5 + id * 0.01,
  lng: 127 + id * 0.01,
  openTime: null,
  closeTime: null,
  is24h: false,
  phone: null,
  note: null,
  homepage: null,
  machines: [],
  distanceKm: null,
  ratingAvg: null,
  reviewCount: 0,
});

const machine = (id: number, name: string, shortName: string): Machine => ({
  id,
  name,
  shortName,
  category: 'rhythm',
});

const ARCADES = [
  arcade(1, '짱오락실 서울대입구점'),
  arcade(2, '짱오락실 홍대점'),
  arcade(3, '게임랜드'),
  arcade(4, '게임랜드'),
  arcade(5, '오락실나라'),
  arcade(6, '홍대 펀시티'),
];

const MACHINES = [
  machine(1, 'Pump It Up', '펌프'),
  machine(2, 'SOUND VOLTEX', '사볼'),
  machine(3, 'DanceDanceRevolution', 'DDR'),
  machine(4, 'jubeat', '유비트'),
];

describe('findMentionedArcade', () => {
  it('지점명을 줄여 써도 알아본다 — "서울대점" ↔ "서울대입구점"', () => {
    const hit = findMentionedArcade(
      '짱오락실 서울대점에 펌프 대기가 많은데 펌프 할 수 있는 가까운 오락실을 찾아줘',
      ARCADES,
    );
    expect(hit?.id).toBe(1);
  });

  it('같은 상호의 지점들은 지점명으로 가른다', () => {
    expect(findMentionedArcade('짱오락실 홍대점 근처 오락실 찾아줘', ARCADES)?.id).toBe(2);
  });

  it('상호와 지점명의 순서가 바뀌어도 알아본다', () => {
    expect(findMentionedArcade('서울대입구 짱오락실 말고 딴 데 찾아줘', ARCADES)?.id).toBe(1);
  });

  it('상호만 적혀 지점을 못 가르면 잡지 않는다 — 아무나 빼느니 아무도 안 뺀다', () => {
    expect(findMentionedArcade('게임랜드 근처 오락실 찾아줘', ARCADES)).toBeNull();
  });

  it('"오락실" 같은 일반 명사에 상호가 걸리지 않는다', () => {
    // '오락실나라' 가 "오락실 나가서" 에 걸리면 그 오락실이 결과에서 빠진다.
    expect(findMentionedArcade('오락실 나가서 갈 만한 데 찾아줘', ARCADES)).toBeNull();
    expect(findMentionedArcade('가까운 오락실 찾아줘', ARCADES)).toBeNull();
  });

  it('언급이 없으면 null', () => {
    expect(findMentionedArcade('펌프 할 수 있는 오락실 찾아줘', ARCADES)).toBeNull();
  });
});

describe('findMentionedMachines', () => {
  it('축약명으로 잡는다', () => {
    const hit = findMentionedMachines('펌프 할 수 있는 데 찾아줘', MACHINES);
    expect(hit.map((m) => m.id)).toEqual([1]);
  });

  it('정식 명칭·대소문자 차이도 잡는다', () => {
    expect(findMentionedMachines('pump it up 있는 곳', MACHINES).map((m) => m.id)).toEqual([1]);
    expect(findMentionedMachines('ddr 있는 오락실 찾아줘', MACHINES).map((m) => m.id)).toEqual([3]);
  });

  it('여러 기종을 적으면 전부 잡는다', () => {
    const hit = findMentionedMachines('펌프랑 사볼 둘 다 있는 데 찾아줘', MACHINES);
    expect(hit.map((m) => m.id)).toEqual([1, 2]);
  });

  it('언급이 없으면 빈 배열', () => {
    expect(findMentionedMachines('가까운 오락실 찾아줘', MACHINES)).toEqual([]);
  });
});

describe('extractConstraints', () => {
  it('사용자의 실제 문장에서 오락실과 기종을 함께 뽑는다', () => {
    const c = extractConstraints(
      '짱오락실 서울대점에 펌프 대기가 많은데 펌프 할 수 있는 가까운 오락실을 찾아줘',
      ARCADES,
      MACHINES,
    );
    expect(c.arcade?.id).toBe(1);
    expect(c.machineIds).toEqual([1]);
    expect(c.machineNames).toEqual(['펌프']);
    // 오락실을 짚었으면 그곳이 기준점 — 지점명 "서울대점" 을 지역으로 또 찾지 않는다
    expect(c.placeQuery).toBeNull();
  });

  it('지역 이름은 뽑기만 하고 좌표는 비워 둔다 — 찾는 건 화면 몫이다', () => {
    const c = extractConstraints('홍대 근처에 사볼 있는 오락실', ARCADES, MACHINES);
    expect(c.placeQuery).toBe('홍대');
    expect(c.place).toBeNull();
    expect(c.machineIds).toEqual([2]);
  });
});

/**
 * 지역은 사전이 없어 "지역이 아닌 말을 지우고 남는 것" 으로 봅니다. 틀리면 엉뚱한 동네로
 * 옮겨 가므로, 여기 못 박는 것: 지역을 적은 문장에서는 지역만 남고, 지역이 없는 문장에서는
 * 아무것도 남지 않는다.
 */
describe('findPlaceQuery', () => {
  it('지역 + 기종 문장에서 지역만 남긴다 — 2026-10-26 베타 QA 의 문장들', () => {
    expect(findPlaceQuery('홍대 근처에 사볼 있는 오락실', MACHINES)).toBe('홍대');
    expect(findPlaceQuery('홍대 사볼', MACHINES)).toBe('홍대');
    expect(findPlaceQuery('강남역 주변 오락실 찾아줘', MACHINES)).toBe('강남역');
  });

  it('붙여 쓴 위치 말과 조사를 뗀다', () => {
    expect(findPlaceQuery('노량진근처 사볼', MACHINES)).toBe('노량진');
    expect(findPlaceQuery('신림역에서 가까운 펌프', MACHINES)).toBe('신림역');
  });

  it("지명 끝 글자와 겹치는 조사는 떼지 않는다 — '종로' 가 '종' 이 되면 안 된다", () => {
    expect(findPlaceQuery('종로 펌프', MACHINES)).toBe('종로');
    expect(findPlaceQuery('강서 유비트', MACHINES)).toBe('강서');
  });

  it('지역을 말하지 않은 문장에서는 아무것도 남지 않는다', () => {
    for (const text of [
      '내 주변 오락실 찾아줘',
      '가까운 오락실 찾아줘',
      '대기 적은 사볼 오락실',
      '사볼 할 수 있는 곳 알려줘',
      '오락실 나가서 갈 만한 데 찾아줘',
      '펌프랑 사볼 둘 다 있는 데 찾아줘',
      '게임랜드 근처 오락실 찾아줘',
      'PIU 있는 곳',
    ]) {
      expect(findPlaceQuery(text, MACHINES), text).toBeNull();
    }
  });
});
