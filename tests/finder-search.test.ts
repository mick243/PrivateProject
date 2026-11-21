import { describe, expect, it } from 'vitest';
import {
  boxCenter,
  boxOf,
  chooseSearchAction,
  favoritesPool,
  readSearch,
} from '@/lib/finder-search';
import type { Machine } from '@/lib/types';

/**
 * 파인더 검색칸 Enter 의 해석 (2026-11-20 사용성 시험 F-4 · F-5).
 * 못 박는 것: 게임 낱말은 칩으로, 나머지는 이름 · 주소 검색어 / 지명으로 나뉘고,
 * 결과 수에 따라 "모두 보기" 와 "그 주변" 이 갈린다.
 */

const machine = (id: number, name: string, shortName: string): Machine => ({
  id,
  name,
  shortName,
  category: 'rhythm',
});

const MACHINES = [
  machine(1, 'PUMP IT UP', '펌프'),
  machine(2, 'SOUND VOLTEX', '사볼'),
  machine(3, 'beatmania IIDX', 'IIDX'),
];

describe('readSearch', () => {
  it('지역 + 게임 — 게임은 칩으로, 지역은 지명으로', () => {
    const r = readSearch('홍대 사볼', MACHINES);
    expect(r.machineIds).toEqual([2]);
    expect(r.machineNames).toEqual(['사볼']);
    expect(r.textQuery).toBe('홍대');
    expect(r.placeQuery).toBe('홍대');
  });

  it('별칭도 게임으로 읽는다 (투덱 → IIDX)', () => {
    const r = readSearch('강남 투덱', MACHINES);
    expect(r.machineIds).toEqual([3]);
    expect(r.textQuery).toBe('강남');
  });

  it('게임 이름뿐이면 검색어 · 지명이 없다', () => {
    const r = readSearch('펌프', MACHINES);
    expect(r.machineIds).toEqual([1]);
    expect(r.textQuery).toBeNull();
    expect(r.placeQuery).toBeNull();
  });

  it('상호에 게임 이름이 섞여 있어도 낱말 통째가 아니면 칩을 켜지 않는다', () => {
    const r = readSearch('펌프오락실', MACHINES);
    expect(r.machineIds).toEqual([]);
    expect(r.textQuery).toBe('펌프오락실');
  });

  it('역 · 동네 이름은 그대로 지명이다', () => {
    const r = readSearch('서울대입구', MACHINES);
    expect(r.machineIds).toEqual([]);
    expect(r.textQuery).toBe('서울대입구');
    expect(r.placeQuery).toBe('서울대입구');
  });

  it('위치 말(근처)은 지명에서 뗀다', () => {
    expect(readSearch('홍대 근처 사볼', MACHINES).placeQuery).toBe('홍대');
  });
});

describe('chooseSearchAction', () => {
  it('이름 · 주소로 여러 곳이면 모두 지도에 맞춘다 (부천 13곳)', () => {
    expect(chooseSearchAction({ textMatches: 13, placeQuery: '부천' })).toEqual({
      action: 'fit',
      fallbackFit: false,
    });
  });

  it('한 곳뿐인데 지명이면 그 주변 — 지명을 못 찾으면 그 한 곳으로 물러선다', () => {
    expect(chooseSearchAction({ textMatches: 1, placeQuery: '서울대입구' })).toEqual({
      action: 'place',
      fallbackFit: true,
    });
  });

  it('0곳이고 지명이면 그 주변', () => {
    expect(chooseSearchAction({ textMatches: 0, placeQuery: '홍대' }).action).toBe('place');
  });

  it('지명이 아니면 한 곳이라도 맞춘다 · 0곳이면 none', () => {
    expect(chooseSearchAction({ textMatches: 1, placeQuery: null }).action).toBe('fit');
    expect(chooseSearchAction({ textMatches: 0, placeQuery: null }).action).toBe('none');
  });
});

describe('boxOf · boxCenter', () => {
  it('점들을 감싸는 사각형과 가운데', () => {
    const box = boxOf([
      { lat: 37.5, lng: 127.0 },
      { lat: 37.6, lng: 126.9 },
      { lat: 37.55, lng: 127.1 },
    ]);
    expect(box).toEqual({ minLat: 37.5, maxLat: 37.6, minLng: 126.9, maxLng: 127.1 });
    const c = boxCenter(box!);
    expect(c.lat).toBeCloseTo(37.55);
    expect(c.lng).toBeCloseTo(127.0);
  });

  it('점이 없으면 null', () => {
    expect(boxOf([])).toBeNull();
  });
});

describe('favoritesPool', () => {
  const all = [
    { id: 1, machines: [{ id: 1 }, { id: 2 }] },
    { id: 2, machines: [{ id: 2 }] },
    { id: 3, machines: [{ id: 1 }] },
  ];

  it('담은 곳만 — 지도 범위와 상관없이', () => {
    expect(favoritesPool(all, new Set([1, 3]), []).map((a) => a.id)).toEqual([1, 3]);
  });

  it('켜 둔 게임이 모두 있는 곳만', () => {
    expect(favoritesPool(all, new Set([1, 2, 3]), [1, 2]).map((a) => a.id)).toEqual([1]);
  });
});
