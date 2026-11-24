import { beforeEach, describe, expect, it, vi } from 'vitest';
import { placesInAnswer, type ChatPlace } from '@/lib/chat-types';
import type { Arcade } from '@/lib/types';

/**
 * 챗봇 오락실 도구 (lib/chat-tools.ts searchArcades) — 2026-11-17 에 더한 세 가지.
 *
 *   1. 기종을 별칭으로 물어도 찾는다 (lib/machine-aliases.ts)
 *   2. 사용자의 기준점이 있으면 가까운 순으로 찾고 거리를 준다
 *   3. 돌려준 오락실의 길찾기 링크를 따로 모은다
 *
 * 2 · 3 에서 못 박는 것은 **모델에게 가는 값**입니다. 기준점 좌표와 지도 주소는 도구 결과에
 * 들어가면 안 됩니다 — 좌표는 개인정보처리방침이, 주소는 모델이 옮기다 틀리는 것이 이유입니다.
 * DB 는 건드리지 않습니다(조회 함수는 대역).
 */

const pageArcades = vi.fn();
vi.mock('@/lib/arcades', () => ({
  listMachines: vi.fn(async () => [
    { id: 1, name: 'Pump It Up', shortName: '펌프', category: 'rhythm' },
    { id: 3, name: 'SOUND VOLTEX', shortName: '사볼', category: 'rhythm' },
    { id: 4, name: 'beatmania IIDX', shortName: 'IIDX', category: 'rhythm' },
  ]),
  pageArcades: (...args: unknown[]) => pageArcades(...args),
}));
vi.mock('@/lib/board', () => ({ listPosts: vi.fn() }));
vi.mock('@/lib/reports', () => ({ listReports: vi.fn() }));

const { searchArcades, radiusOf, MAX_RADIUS_KM } = await import('@/lib/chat-tools');

const arcade = (id: number, name: string, distanceKm: number | null): Arcade => ({
  id,
  name,
  address: '서울 마포구 서교동 1',
  lat: 37.55 + id * 0.001,
  lng: 126.92 + id * 0.001,
  openTime: null,
  closeTime: null,
  is24h: false,
  phone: null,
  note: null,
  homepage: null,
  machines: [],
  distanceKm,
  ratingAvg: null,
  reviewCount: 0,
});

/** 사용자의 기준점 — 결과 어디에도 이 숫자가 보이면 안 된다 */
const NEAR = { lat: 37.123456, lng: 127.654321 };

beforeEach(() => {
  pageArcades.mockReset();
  pageArcades.mockResolvedValue({ arcades: [], total: 0 });
});

describe('searchArcades — 기종 별칭', () => {
  it("'PIU' · '투덱' 으로 물어도 그 기종으로 좁힌다", async () => {
    await searchArcades({ machine: 'PIU' });
    expect(pageArcades.mock.calls[0]![0].machineIds).toEqual([1]);

    await searchArcades({ machine: '투덱' });
    expect(pageArcades.mock.calls[1]![0].machineIds).toEqual([4]);
  });

  it('모르는 기종이면 조회하지 않고 못 찾았다고 알린다', async () => {
    const out = (await searchArcades({ machine: '테트리스' })) as { error: string };
    expect(out.error).toContain('테트리스');
    expect(pageArcades).not.toHaveBeenCalled();
  });
});

describe('searchArcades — 기준점과 반경', () => {
  it('기준점이 있으면 좌표를 조회에 넘기고, 가까운 순이라고 알리며 거리를 준다', async () => {
    pageArcades.mockResolvedValue({ arcades: [arcade(1, '홍대 펀시티', 0.85), arcade(2, '신촌 게임파크', 2.34)], total: 2 });

    const out = (await searchArcades({ machine: '사볼', radiusKm: 5 }, { near: NEAR })) as {
      order: string;
      note?: string;
      arcades: { name: string; distance?: string }[];
    };

    expect(pageArcades.mock.calls[0]![0]).toMatchObject({ lat: NEAR.lat, lng: NEAR.lng, radiusKm: 5, machineIds: [3] });
    expect(out.order).toContain('가까운 순');
    expect(out.note).toBeUndefined();
    expect(out.arcades.map((a) => a.distance)).toEqual(['850m', '2.3km']);
  });

  it('기준점 좌표는 모델이 읽는 결과에 들어가지 않는다', async () => {
    pageArcades.mockResolvedValue({ arcades: [arcade(1, '홍대 펀시티', 0.85)], total: 1 });

    const out = await searchArcades({ radiusKm: 5 }, { near: NEAR, places: new Map() });

    const json = JSON.stringify(out);
    expect(json).not.toContain('37.123456');
    expect(json).not.toContain('127.654321');
    // 오락실 좌표와 지도 주소도 싣지 않는다 — 길찾기 링크는 places 로만 나간다
    expect(json).not.toContain('map.kakao.com');
    expect(json).not.toMatch(/"lat"|"lng"/);
  });

  it('기준점이 없으면 반경을 넘기지 않고, 그 사실을 모델에게 알린다', async () => {
    const out = (await searchArcades({ radiusKm: 5 })) as { order: string; note?: string };

    expect(pageArcades.mock.calls[0]![0]).toMatchObject({ lat: null, lng: null, radiusKm: null });
    expect(out.order).toContain('이름순');
    expect(out.note).toContain('기준점을 받지 못해');
  });

  it('반경을 묻지 않았으면 기준점이 없어도 따로 알릴 것이 없다', async () => {
    const out = (await searchArcades({ query: '홍대' })) as { note?: string };
    expect(out.note).toBeUndefined();
  });

  it('반경은 0 초과 · 상한 이하로만 받는다', () => {
    expect(radiusOf(5)).toBe(5);
    expect(radiusOf('3')).toBe(3);
    expect(radiusOf(9999)).toBe(MAX_RADIUS_KM);
    // 화면 반경 칩과 같은 5km 상한 (2026-11-24)
    expect(MAX_RADIUS_KM).toBe(5);
    expect(radiusOf(20)).toBe(5);
    for (const bad of [0, -1, NaN, 'abc', null, undefined]) expect(radiusOf(bad), String(bad)).toBeNull();
  });
});

describe('searchArcades — 길찾기 링크', () => {
  it('돌려준 오락실의 길찾기 링크와 거리를 places 에 모은다', async () => {
    const funcity = arcade(1, '홍대 펀시티', 0.85);
    pageArcades.mockResolvedValue({ arcades: [funcity], total: 1 });
    const places = new Map<string, ChatPlace>();

    await searchArcades({}, { near: NEAR, places });

    expect([...places.values()]).toEqual([
      {
        name: '홍대 펀시티',
        distance: '850m',
        // 목적지는 **오락실** 좌표다 (lib/place-links.ts) — 사용자의 기준점이 아니다
        directions: `https://map.kakao.com/link/to/${encodeURIComponent('홍대 펀시티')},${funcity.lat},${funcity.lng}`,
      },
    ]);
    expect(places.get('홍대 펀시티')!.directions).not.toContain('37.123456');
  });

  it('같은 이름의 오락실은 먼저 나온 곳(더 가까운 곳)을 남긴다', async () => {
    pageArcades.mockResolvedValue({ arcades: [arcade(1, '게임랜드', 0.4), arcade(2, '게임랜드', 3.1)], total: 2 });
    const places = new Map<string, ChatPlace>();

    await searchArcades({}, { near: NEAR, places });

    expect(places.size).toBe(1);
    expect(places.get('게임랜드')!.distance).toBe('400m');
  });

  it('기준점이 없으면 거리 없이 링크만 준다', async () => {
    pageArcades.mockResolvedValue({ arcades: [arcade(1, '홍대 펀시티', null)], total: 1 });
    const places = new Map<string, ChatPlace>();

    await searchArcades({ query: '홍대' }, { places });

    expect(places.get('홍대 펀시티')).toMatchObject({ distance: undefined });
    expect(places.get('홍대 펀시티')!.directions).toContain('map.kakao.com/link/to/');
  });
});

describe('placesInAnswer — 답변에 나온 곳만 단다', () => {
  const place = (name: string): ChatPlace => ({ name, directions: `https://map.kakao.com/link/to/${name}` });
  const all = [place('신촌 게임파크'), place('홍대 펀시티'), place('건대 스테이지원')];

  it('이름이 답변에 나온 곳만, 나온 순서대로 고른다', () => {
    const text = '가장 가까운 곳은 홍대 펀시티이고, 그다음은 신촌 게임파크입니다.';
    expect(placesInAnswer(text, all).map((p) => p.name)).toEqual(['홍대 펀시티', '신촌 게임파크']);
  });

  it('띄어쓰기가 달라도 같은 곳으로 본다', () => {
    expect(placesInAnswer('홍대펀시티로 가세요', all).map((p) => p.name)).toEqual(['홍대 펀시티']);
  });

  it('긴 이름 안에 든 짧은 이름은 따로 나오지 않았으면 달지 않는다', () => {
    // 로컬 확인에서 "funny 게임랜드" 만 말한 답에 "게임랜드" 링크가 함께 붙었다.
    const both = [place('게임랜드'), place('funny 게임랜드')];
    expect(placesInAnswer('funny 게임랜드에 있습니다.', both).map((p) => p.name)).toEqual(['funny 게임랜드']);
    // 둘 다 말했으면 둘 다, 나온 순서대로
    expect(placesInAnswer('게임랜드와 funny 게임랜드 두 곳입니다.', both).map((p) => p.name)).toEqual([
      '게임랜드',
      'funny 게임랜드',
    ]);
  });

  it('답변이 말하지 않았으면 아무것도 달지 않는다', () => {
    expect(placesInAnswer('근처에 등록된 오락실을 찾지 못했습니다.', all)).toEqual([]);
  });

  it('다섯 곳까지만 단다', () => {
    const many = Array.from({ length: 8 }, (_, i) => place(`오락실${i}호`));
    const text = many.map((p) => p.name).join(', ');
    expect(placesInAnswer(text, many)).toHaveLength(5);
  });
});
