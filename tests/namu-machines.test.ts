import { describe, expect, it } from 'vitest';
import {
  addressKeys,
  indexArcades,
  matchStore,
  nameKey,
  nameScore,
  type DbArcade,
  type NamuStore,
} from '@/lib/namu-machines';

/**
 * 나무위키 점포 → 우리 오락실 짝짓기. 여기 못 박는 것:
 *   - 같은 주소를 다르게 적어도(머리말 · 상호 꼬리 · 옛 시·도 이름) 같은 열쇠가 된다
 *   - 확신이 없으면 짝짓지 않는다 — 엉뚱한 오락실에 기종을 붙이는 것이 빠뜨리는 것보다 나쁘다
 * 주소 예시는 개발 DB 와 나무위키의 실제 꼴이다.
 */

const store = (over: Partial<NamuStore>): NamuStore => ({
  doc: '서울/강남',
  path: ['관악구'],
  name: '짱오락실 서울대입구점',
  addresses: [],
  checked: null,
  closed: false,
  machines: [{ game: '펌프', count: 3 }],
  ...over,
});

const ARCADES: DbArcade[] = [
  { id: 60, name: '짱오락실 서울대입구점', address: '서울특별시 관악구 관악로15길 6 짱오락실 서울대입구점' },
  { id: 61, name: '짱오락실 신림점', address: '서울특별시 관악구 신림로59길 12' },
  { id: 70, name: '롯데월드 게임빌리지', address: '서울특별시 송파구 올림픽로 240' },
  { id: 71, name: '롯데월드 펀시티', address: '서울특별시 송파구 올림픽로 240' },
  { id: 80, name: '대빵오락실', address: '서울특별시 강남구 강남대로152길 28' },
  { id: 81, name: '대빵오락실 압구정점', address: '서울특별시 강남구 선릉로157길 26' },
  { id: 90, name: '게임존', address: '부산광역시 중구 중앙대로 10' },
  { id: 91, name: '게임존', address: '서울특별시 중구 중앙대로 10' },
];
const index = indexArcades(ARCADES);

describe('addressKeys', () => {
  it('머리말 · 상호 꼬리가 달라도 같은 열쇠', () => {
    expect(addressKeys('신 주소: 서울특별시 관악구 관악로15길 6')).toEqual(addressKeys(ARCADES[0].address));
  });

  it('(구)…(신)… 처럼 붙은 두 주소를 따로 뽑는다', () => {
    expect(addressKeys('서울특별시 동작구 만양로 104 1층(구)서울특별시 동작구 노량진로 174 지하 1층(신)')).toEqual([
      '서울특별시|동작구|만양로|104',
      '서울특별시|동작구|노량진로|174',
    ]);
  });

  it('도로명 가운데의 띄어쓰기("고현로 11길")를 붙여 읽는다', () => {
    expect(addressKeys('경상남도 거제시 고현로 11길 14')).toEqual(addressKeys('경상남도 거제시 고현로11길 14, 1층 (고현동)'));
  });

  it('시·도 없이 적힌 주소는 문서의 시·도를 붙여 읽는다', () => {
    expect(addressKeys('관악구 관악로 173', '서울특별시')).toEqual(['서울특별시|관악구|관악로|173']);
  });

  it('옛 시·도 이름(광주광역시)도 지금 이름으로 맞춘다', () => {
    expect(addressKeys('광주광역시 북구 중흥동 123-4')).toEqual(addressKeys('전남광주통합특별시 북구 중흥동 123-4'));
  });

  it('구·시를 못 읽으면 열쇠를 만들지 않는다 — 도로명만으로는 전국에서 겹친다', () => {
    expect(addressKeys('중앙대로 10')).toEqual([]);
  });

  it('같은 도로명이라도 시가 다르면 다른 열쇠', () => {
    expect(addressKeys(ARCADES[6].address)).not.toEqual(addressKeys(ARCADES[7].address));
  });
});

describe('nameKey · nameScore', () => {
  it('표식 · 괄호 · 띄어쓰기를 뗀다', () => {
    expect(nameKey('천호 왕오락실 (구 J&J 게임랜드) ⓐ')).toBe('천호왕오락실');
  });

  it('같으면 1, 한쪽이 다른 쪽을 품으면 0.9', () => {
    expect(nameScore('짱오락실 신림점', '짱오락실신림점')).toBe(1);
    expect(nameScore('노량진 어뮤즈타운', '어뮤즈타운')).toBe(0.9);
  });

  it('지점이 다르면 품고 있어도 가산하지 않는다 — 체인은 같은 구에 여럿이다', () => {
    expect(nameScore('대빵오락실 강남점', '대빵오락실')).toBeLessThan(0.75);
    expect(nameScore('대빵오락실 압구정점', '대빵오락실 천호점')).toBeLessThan(0.75);
  });

  it('지점명 뒤에 다른 말이 붙어도 지점을 읽는다', () => {
    expect(nameScore('짱오락실 부산삼정타워점 & 히어로 보드게임카페', '짱오락실')).toBeLessThan(0.75);
  });

  it('괄호 속 다른 이름 · 옛 이름으로도 견준다', () => {
    expect(nameScore('부천 P2존 (뽀끼뽀끼 오락실)', '뽀끼뽀끼오락실')).toBe(1);
    expect(nameScore('해운동 댓거리 가족게임랜드 (구 자바게임랜드)', '자바게임랜드')).toBe(1);
  });

  it('긴 이름 안에 짧은 이름의 글자쌍이 대부분 들어 있으면 높게', () => {
    const fun = nameScore('잠실 롯데월드 어드벤처 아이스가든 펀시티', '롯데월드 펀시티');
    const other = nameScore('잠실 롯데월드 어드벤처 아이스가든 펀시티', '롯데월드 게임빌리지');
    expect(fun).toBeGreaterThan(0.5);
    expect(fun - other).toBeGreaterThan(0.15);
  });
});

describe('matchStore', () => {
  it('주소가 하나로 맞으면 그 오락실', () => {
    const m = matchStore(store({ addresses: ['신 주소: 서울특별시 관악구 관악로15길 6'] }), ARCADES, index);
    expect(m).toMatchObject({ kind: 'matched', arcadeId: 60, by: 'address' });
  });

  it('한 건물에 여럿이면 이름으로 고른다', () => {
    const m = matchStore(
      store({ doc: '서울/강남', path: ['송파구'], name: '잠실 롯데월드 어드벤처 아이스가든 펀시티', addresses: ['서울특별시 송파구 올림픽로 240'] }),
      ARCADES,
      index,
    );
    expect(m).toMatchObject({ kind: 'matched', arcadeId: 71, by: 'address+name' });
  });

  it('한 건물에 여럿인데 이름으로도 못 고르면 애매 — 짝짓지 않는다', () => {
    const m = matchStore(
      store({ path: ['송파구'], name: '잠실 게임장', addresses: ['서울특별시 송파구 올림픽로 240'] }),
      ARCADES,
      index,
    );
    expect(m).toMatchObject({ kind: 'ambiguous', by: 'address+name' });
  });

  it('주소가 없으면 같은 구 안에서 이름이 거의 같을 때만', () => {
    expect(matchStore(store({ name: '짱오락실 신림점' }), ARCADES, index)).toMatchObject({
      kind: 'matched',
      arcadeId: 61,
      by: 'name',
    });
  });

  it('주소가 없고 같은 이름이 다른 구에만 있으면 짝짓지 않는다', () => {
    expect(matchStore(store({ path: ['서초구'], name: '짱오락실 신림점' }), ARCADES, index)).toEqual({ kind: 'none' });
  });

  it('이름이 비슷한 지점이 둘이면 애매', () => {
    const m = matchStore(store({ path: ['강남구'], name: '대빵오락실 강남점' }), ARCADES, index);
    expect(m.kind).not.toBe('matched');
  });

  it('흔한 낱말만 있는 행("오락실")에 이름만으로 짝짓지 않는다', () => {
    const rows: DbArcade[] = [{ id: 1, name: '오락실', address: '경기도 양주시 광적면 가래비길 135-3' }];
    const m = matchStore(store({ doc: '경기/북부', path: ['양주시'], name: '메가박스 오락실' }), rows, indexArcades(rows));
    expect(m.kind).not.toBe('matched');
  });

  it('주소 없이 체인 이름뿐인 행("짱오락실")에는 짝짓지 않는다 — 같은 구의 다른 지점일 수 있다', () => {
    const rows: DbArcade[] = [
      { id: 1, name: '짱오락실', address: '경기도 이천시 부발읍 경충대로 2100' },
      { id: 2, name: '짱오락실', address: '충청북도 청주시 상당구 성안로 13' },
    ];
    const m = matchStore(store({ doc: '경기/남부', path: ['이천시'], name: '이천 짱오락실' }), rows, indexArcades(rows));
    expect(m.kind).not.toBe('matched');
  });

  it('사람이 정한 짝은 이름 + 주소로 찾는다 — DB 마다 id 가 달라도 같은 행', () => {
    const ref = { name: '대빵오락실', address: '서울특별시 강남구 강남대로152길 28' };
    expect(matchStore(store({ name: '아무 이름', arcadeRef: ref }), ARCADES, index)).toMatchObject({
      kind: 'matched',
      arcadeId: 80,
      by: 'manual',
    });
    const otherDb = ARCADES.map((a) => ({ ...a, id: a.id + 1000 }));
    expect(matchStore(store({ name: '아무 이름', arcadeRef: ref }), otherDb, indexArcades(otherDb))).toMatchObject({
      arcadeId: 1080,
    });
  });

  it('사람이 정한 짝의 행이 이 DB 에 없으면 짝짓지 않는다', () => {
    const ref = { name: '없는 오락실', address: '서울특별시 강남구 어딘가 1' };
    expect(matchStore(store({ arcadeRef: ref }), ARCADES, index)).toEqual({ kind: 'none' });
  });

  it('사람이 정한 짝(arcadeId)이 먼저다', () => {
    expect(matchStore(store({ name: '아무 이름', arcadeId: 80 }), ARCADES, index)).toMatchObject({
      kind: 'matched',
      arcadeId: 80,
      by: 'manual',
    });
  });

  it('주소는 하나로 맞아도 이름이 전혀 다르면 애매로 돌린다', () => {
    const m = matchStore(
      store({ path: ['관악구'], name: '핑키펑키 버니하우스', addresses: ['서울특별시 관악구 관악로15길 6'] }),
      ARCADES,
      index,
    );
    expect(m).toMatchObject({ kind: 'ambiguous', by: 'address' });
  });
});
