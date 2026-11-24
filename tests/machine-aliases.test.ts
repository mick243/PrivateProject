import { describe, expect, it } from 'vitest';
import { machineTerms, matchMachines, resolveMachines } from '@/lib/machine-aliases';
import { findMentionedMachines, findPlaceQuery } from '@/lib/query-constraints';
import type { Machine } from '@/lib/types';

/**
 * 기종 별칭 사전 (lib/machine-aliases.ts).
 *
 * 2026-11-17 점검에서 챗봇 도구가 'PIU' · '투덱' · '이지투' · '마이마이' 에 "기종을 찾지
 * 못했습니다" 를 돌려주는 것을 확인했습니다 — 기종 표의 축약명은 '펌프' · 'IIDX' · 'EZ2AC' ·
 * 'maimai' 입니다. 여기 못 박는 것: 그 말들이 이제 잡히고, 별칭 때문에 다른 기종이나 지역이
 * 딸려 오지 않는다.
 */

/** 시드(prisma/migrations/20260101000100_seed)의 기종 표 그대로 */
const SEED: [string, string][] = [
  ['Pump It Up', '펌프'],
  ['EZ2AC', 'EZ2AC'],
  ['SOUND VOLTEX', '사볼'],
  ['beatmania IIDX', 'IIDX'],
  ['太鼓の達人 (태고의 달인)', '태고'],
  ['DanceDanceRevolution', 'DDR'],
  ['maimai DX', 'maimai'],
  ['CHUNITHM', '츄니즘'],
  ['jubeat', '유비트'],
  ['EZ2DJ', 'EZ2DJ'],
  ['GITADORA', '기타도라'],
  ['DANCERUSH STARDOM', '댄스러쉬'],
  ["pop'n music", '팝픈'],
  ['ノスタルジア (노스탤지어)', '노스탤지어'],
  ['BEAT ON (비트온)', '비트온'], // migrate-086
];
const MACHINES: Machine[] = SEED.map(([name, shortName], i) => ({
  id: i + 1,
  name,
  shortName,
  category: 'rhythm',
}));

const shortNames = (hit: Machine[]) => hit.map((m) => m.shortName);

describe('matchMachines — 문장에 언급된 기종', () => {
  it('점검에서 실패하던 별칭을 잡는다', () => {
    expect(shortNames(matchMachines('PIU 있는 곳', MACHINES))).toEqual(['펌프']);
    expect(shortNames(matchMachines('투덱 할 수 있는 데', MACHINES))).toEqual(['IIDX']);
    expect(shortNames(matchMachines('이지투 있는 오락실', MACHINES))).toEqual(['EZ2AC']);
    expect(shortNames(matchMachines('홍대 마이마이', MACHINES))).toEqual(['maimai']);
  });

  it('이미 되던 이름·축약명은 그대로 잡는다', () => {
    expect(shortNames(matchMachines('사볼이랑 츄니즘 둘 다', MACHINES))).toEqual(['사볼', '츄니즘']);
    expect(shortNames(matchMachines('pump it up 있는 곳', MACHINES))).toEqual(['펌프']);
    expect(shortNames(matchMachines('sound voltex', MACHINES))).toEqual(['사볼']);
  });

  it("'이지투디제이' 는 EZ2DJ 하나다 — 안에 든 '이지투' 가 EZ2AC 로 또 읽히지 않는다", () => {
    // 둘 다 잡히면 기종 필터가 "둘 다 있는 곳"(AND)이 되어 거의 0곳이 된다.
    expect(shortNames(matchMachines('이지투디제이 있는 곳', MACHINES))).toEqual(['EZ2DJ']);
    expect(shortNames(matchMachines('ez2dj', MACHINES))).toEqual(['EZ2DJ']);
    expect(shortNames(matchMachines('ez2ac', MACHINES))).toEqual(['EZ2AC']);
  });

  it('기종 말이 없으면 아무것도 잡지 않는다', () => {
    for (const text of ['가까운 오락실 찾아줘', '홍대 근처', '주말에 갈 만한 데', '']) {
      expect(matchMachines(text, MACHINES), text).toEqual([]);
    }
  });

  it('기종 표에 없는 기종의 별칭은 쓰이지 않는다', () => {
    const onlyPump = MACHINES.filter((m) => m.shortName === '펌프');
    expect(matchMachines('투덱 있는 곳', onlyPump)).toEqual([]);
  });
});

describe('machineTerms', () => {
  it('정식 명칭 · 축약명 · 별칭을 공백 없는 소문자로 준다', () => {
    const pump = MACHINES[0]!;
    expect(machineTerms(pump)).toEqual(expect.arrayContaining(['펌프', 'pumpitup', 'piu']));
  });

  it('별칭은 전부 2글자 이상이다 — 한 글자는 우연히 걸린다', () => {
    for (const m of MACHINES) {
      for (const term of machineTerms(m)) expect(term.length, `${m.shortName}: ${term}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('한 낱말이 두 기종의 말이 되지 않는다', () => {
    const owner = new Map<string, string>();
    for (const m of MACHINES) {
      for (const term of machineTerms(m)) {
        expect(owner.get(term) ?? m.shortName, term).toBe(m.shortName);
        owner.set(term, m.shortName);
      }
    }
  });
});

describe('resolveMachines — 챗봇 도구의 machine 인자', () => {
  it('별칭 · 정식 명칭 · 축약명 어느 것으로 와도 같은 기종이다', () => {
    for (const name of ['PIU', 'piu', '펌프', 'Pump It Up', '펌프 잇 업']) {
      expect(shortNames(resolveMachines(name, MACHINES)), name).toEqual(['펌프']);
    }
    expect(shortNames(resolveMachines('투덱', MACHINES))).toEqual(['IIDX']);
    expect(shortNames(resolveMachines('마이마이', MACHINES))).toEqual(['maimai']);
  });

  it('버전을 붙여 적어도 찾는다', () => {
    expect(shortNames(resolveMachines('사운드 볼텍스 익시드 기어', MACHINES))).toEqual(['사볼']);
  });

  it('이름을 덜 적으면 그 말이 든 기종으로 물러선다', () => {
    expect(shortNames(resolveMachines('pump', MACHINES))).toEqual(['펌프']);
    // 'EZ2' 는 둘 다다 — 이쪽은 예전 동작 그대로 둔다.
    expect(shortNames(resolveMachines('EZ2', MACHINES))).toEqual(['EZ2AC', 'EZ2DJ']);
  });

  it('모르는 이름과 빈 값은 빈 배열', () => {
    expect(resolveMachines('테트리스', MACHINES)).toEqual([]);
    expect(resolveMachines('', MACHINES)).toEqual([]);
    expect(resolveMachines(null, MACHINES)).toEqual([]);
  });
});

describe('문장 제약(lib/query-constraints.ts)이 같은 사전을 쓴다', () => {
  it('별칭으로 적은 기종을 탐색 조건으로 뽑는다', () => {
    expect(shortNames(findMentionedMachines('홍대 투덱', MACHINES))).toEqual(['IIDX']);
  });

  it('별칭은 지역 이름으로 넘어가지 않는다', () => {
    // 예전에는 '투덱' 이 지역 후보로 남아 지역 검색에 "홍대 투덱" 이 실렸다.
    expect(findPlaceQuery('홍대 투덱', MACHINES)).toBe('홍대');
    expect(findPlaceQuery('강남역 근처 마이마이', MACHINES)).toBe('강남역');
    expect(findPlaceQuery('이지투 있는 곳', MACHINES)).toBeNull();
  });
});

describe('비트온 (migrate-086)', () => {
  it('손펌프 · 비트온은 비트온이고, 펌프는 비트온을 끌어오지 않는다', () => {
    expect(shortNames(matchMachines('손펌프 있는 곳', MACHINES))).toEqual(['비트온']);
    expect(shortNames(matchMachines('비트온 있는 곳', MACHINES))).toEqual(['비트온']);
    expect(shortNames(matchMachines('펌프 있는 곳', MACHINES))).toEqual(['펌프']);
  });
});
