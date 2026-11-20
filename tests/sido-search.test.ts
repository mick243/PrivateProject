import { describe, expect, it } from 'vitest';
import { ALT_SEPARATOR, searchTokens } from '@/lib/arcades';
import { isCityQuery } from '@/lib/place-search';
import { canonicalSidoFor, provinceOf, regionOf } from '@/lib/region-cluster';

/**
 * 시·도 이름으로 검색하기 (2026-11-20).
 *
 * 주소는 정식 이름("충청남도 …" · "전남광주통합특별시 …")으로만 저장돼 있어서 "충남" · "전라남도" ·
 * "광주광역시" · "강원도" 로 찾으면 0곳이었습니다. 이제 그런 낱말에는 정식 이름을 대안으로 붙이고,
 * SQL 이 둘 중 하나만 맞으면 찾습니다(prisma/sql/arcadesWithMachines.sql 조건 블록).
 * 개발 DB 실측: 전라남도 0→71 · 충남 0→50 · 강원도 0→47 · 광주시 4→75(경기 광주시도 그대로).
 */

describe('canonicalSidoFor', () => {
  it('주소에 안 걸리던 줄임말 · 옛 이름을 정식 이름으로', () => {
    expect(canonicalSidoFor('전라남도')).toBe('전남광주통합특별시');
    expect(canonicalSidoFor('광주광역시')).toBe('전남광주통합특별시');
    expect(canonicalSidoFor('광주시')).toBe('전남광주통합특별시');
    expect(canonicalSidoFor('충남')).toBe('충청남도');
    expect(canonicalSidoFor('경북')).toBe('경상북도');
    expect(canonicalSidoFor('전라북도')).toBe('전북특별자치도');
    expect(canonicalSidoFor('강원도')).toBe('강원특별자치도');
    expect(canonicalSidoFor('제주도')).toBe('제주특별자치도');
    expect(canonicalSidoFor('부산시')).toBe('부산광역시');
  });

  it('정식 이름 안에 이미 든 말은 대안이 필요 없다 — 원래 말로 걸린다', () => {
    for (const w of ['전남', '광주', '전남광주', '서울', '부산', '경기', '제주', '강원', '전북']) {
      expect(canonicalSidoFor(w), w).toBeNull();
    }
  });

  it('시·도가 아닌 말은 건드리지 않는다', () => {
    for (const w of ['홍대', '여수', '천안시', '게임랜드', '']) expect(canonicalSidoFor(w), w).toBeNull();
  });
});

describe('searchTokens — 시·도 낱말에 정식 이름을 대안으로', () => {
  it('대안은 제어 문자로 붙는다 (사람이 칠 수 없는 글자)', () => {
    expect(searchTokens('전라남도 여수')).toEqual([`전라남도${ALT_SEPARATOR}전남광주통합특별시`, '여수']);
    expect(searchTokens('충남')).toEqual([`충남${ALT_SEPARATOR}충청남도`]);
  });

  it('원래 말은 지우지 않는다 — "경북대점" · 경기도 광주시처럼 원래 말로 걸리던 곳이 남는다', () => {
    expect(searchTokens('경북')?.[0]?.split(ALT_SEPARATOR)[0]).toBe('경북');
    expect(searchTokens('광주시')?.[0]?.split(ALT_SEPARATOR)[0]).toBe('광주시');
  });

  it('사람이 넣은 제어 문자는 낱말 경계일 뿐이라 대안으로 둔갑하지 않는다', () => {
    expect(searchTokens(`전남${ALT_SEPARATOR}홍대`)).toEqual(['전남', '홍대']);
  });

  it('시·도가 아닌 검색어는 예전과 같다', () => {
    expect(searchTokens('홍대 짱')).toEqual(['홍대', '짱']);
    expect(searchTokens('  ')).toBeNull();
    expect(searchTokens(null)).toBeNull();
  });
});

describe('provinceOf — 시·도 이름으로 엔터를 누르면 그 지역으로 (2026-11-20)', () => {
  it('줄임말 · 옛 이름 · 정식 이름 모두 같은 시·도로', () => {
    for (const w of ['전남', '전라남도', '전남광주', '광주광역시', '전남광주통합특별시', ' 전남 ']) {
      expect(provinceOf(w)?.key, w).toBe('전남광주통합특별시');
    }
    expect(provinceOf('충남')?.label).toBe('충남');
    expect(provinceOf('충청남도')?.key).toBe('충청남도');
  });

  it('서울 · 광역시 · 세종은 도시라 더 당겨 보여 준다 (통합특별시는 도처럼)', () => {
    expect(provinceOf('서울')?.isCity).toBe(true);
    expect(provinceOf('부산광역시')?.isCity).toBe(true);
    expect(provinceOf('세종')?.isCity).toBe(true);
    expect(provinceOf('전남')?.isCity).toBe(false);
    expect(provinceOf('경기')?.isCity).toBe(false);
  });

  it('시·도가 아니거나 뒤에 낱말이 더 붙으면 null — "전남 여수" 는 지점 검색이다', () => {
    for (const w of ['전남 여수', '여수', '홍대', '광산구', '']) expect(provinceOf(w), w).toBeNull();
  });

  it('isCityQuery 도 시·도 이름을 지역 검색으로 본다 — 첫 매치 한 곳으로 당기지 않게', () => {
    expect(isCityQuery('전남')).toBe(true);
    expect(isCityQuery('충청남도')).toBe(true);
    expect(isCityQuery('청주시')).toBe(true);
    expect(isCityQuery('전남 여수')).toBe(false);
    expect(isCityQuery('게임랜드')).toBe(false);
  });
});

describe("regionOf — '전남광주' 줄임 표기 (2026-11-20 전에는 시·도로 읽히지 않았다)", () => {
  it('전남광주 · 전남 · 전라남도 · 정식 이름이 모두 같은 묶음이다', () => {
    const key = regionOf('전남광주통합특별시 여수시 좌수영로 1')?.province.key;
    for (const a of ['전남광주 여수시 좌수영로 1', '전남 여수시 좌수영로 1', '전라남도 여수시 좌수영로 1']) {
      expect(regionOf(a)?.province.key, a).toBe(key);
    }
    expect(regionOf('전남광주 광산구 첨단중앙로 1')?.city.label).toBe('광주');
  });

  it('지도 이름표는 통합 뒤의 줄임 이름 전남광주다', () => {
    expect(regionOf('전남 여수시 좌수영로 1')?.province.label).toBe('전남광주');
  });
});
