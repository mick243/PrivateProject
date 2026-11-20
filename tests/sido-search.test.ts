import { describe, expect, it } from 'vitest';
import { ALT_SEPARATOR, searchTokens } from '@/lib/arcades';
import { canonicalSidoFor } from '@/lib/region-cluster';

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
