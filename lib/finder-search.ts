/**
 * 파인더 검색칸의 **Enter** 를 읽는 순수 로직 (components/ArcadeFinder.tsx).
 *
 * 2026-11-20 사용성 시험(F-4 · F-5)에서 고친 것:
 *  - Enter 를 누르면 첫 결과 한 곳으로 날아가고 검색어가 지워졌다. 이제 Enter 는
 *    **찾은 곳을 모두 지도에 맞춰** 보여 주고 검색어는 남긴다. 한 곳으로 가는 건 목록에서
 *    그 줄을 누를 때뿐이다.
 *  - '서울대입구' · '홍대 사볼' 을 이름 · 주소 글자로만 찾아 엉뚱한 곳이 나왔다. 도우미가 쓰는
 *    해석(lib/query-constraints.ts · lib/machine-aliases.ts)을 그대로 빌려, 게임 이름은 게임
 *    칩으로, 나머지는 지명이면 그 위치 주변으로 읽는다.
 *
 * 네트워크는 여기서 부르지 않는다 — 화면이 조회한 결과 수를 넘겨받아 무엇을 할지만 정한다.
 */

import type { LatLngBox } from './geo';
import { cleanPlaceQuery } from './chat-intent';
import { machineTerms } from './machine-aliases';
import { findPlaceQuery } from './query-constraints';
import type { Machine } from './types';

type Named = Pick<Machine, 'id' | 'name' | 'shortName'>;

export interface SearchReading {
  /** 검색어에 든 게임 — 게임 칩으로 켠다 */
  machineIds: number[];
  machineNames: string[];
  /** 게임 낱말을 뺀 나머지 — 이름 · 주소로 찾을 말. 남는 게 없으면 null */
  textQuery: string | null;
  /** 지명으로 물어볼 말 ('홍대 근처 사볼' → '홍대'). 없으면 null */
  placeQuery: string | null;
}

/**
 * 낱말 하나가 **통째로** 게임 이름인가 (정식 명칭 · 축약명 · 별칭).
 *
 * 도우미의 matchMachines 는 문장 속 부분 일치로 찾지만, 검색칸은 오락실 이름을 치는 곳이라
 * '펌프오락실' 같은 상호가 펌프 칩을 켜면 안 된다. 그래서 낱말 단위로만 본다.
 */
function machineOfToken<T extends Named>(token: string, machines: readonly T[]): T | null {
  const t = token.toLowerCase();
  return machines.find((m) => machineTerms(m).includes(t)) ?? null;
}

/** 검색어를 게임 · 이름 검색어 · 지명으로 나눈다 */
export function readSearch(text: string, machines: readonly Named[]): SearchReading {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const hit: Named[] = [];
  const rest: string[] = [];
  for (const token of tokens) {
    const m = machineOfToken(token, machines);
    if (m) {
      if (!hit.includes(m)) hit.push(m);
    } else {
      rest.push(token);
    }
  }
  const textQuery = rest.join(' ');
  // 지명 해석은 도우미와 같은 함수를 쓴다 — 두 기능이 같은 말을 다르게 읽지 않게.
  // '우리 동네' · '친구랑' 같은 일상어도 도우미와 똑같이 걷어 낸다 (lib/chat-intent.ts)
  const placeQuery = textQuery
    ? cleanPlaceQuery(findPlaceQuery(textQuery, machines as Machine[]))
    : null;
  return {
    machineIds: hit.map((m) => m.id),
    machineNames: hit.map((m) => m.shortName),
    textQuery: textQuery || null,
    placeQuery,
  };
}

/**
 * 무엇을 할지.
 *  - `fit`   이름 · 주소로 찾은 곳이 여럿 — 모두 지도에 맞춘다 ('부천' → 부천의 13곳)
 *  - `place` 찾은 곳이 한 곳 이하인데 지명으로 읽힌다 — 그 위치 주변을 보여 준다
 *            ('서울대입구' 는 이름에 그 말이 든 1곳보다 역 주변이 답이다)
 *  - `none`  찾은 것도 지명도 없다
 *
 * 지명 조회가 실패하면 화면이 한 곳짜리 결과로 물러선다 (fallbackFit).
 */
export function chooseSearchAction({
  textMatches,
  placeQuery,
}: {
  textMatches: number;
  placeQuery: string | null;
}): { action: 'fit' | 'place' | 'none'; fallbackFit: boolean } {
  if (textMatches >= 2) return { action: 'fit', fallbackFit: false };
  if (placeQuery) return { action: 'place', fallbackFit: textMatches === 1 };
  if (textMatches === 1) return { action: 'fit', fallbackFit: false };
  return { action: 'none', fallbackFit: false };
}

/** 점들을 감싸는 사각형. 점이 없으면 null */
export function boxOf(points: readonly { lat: number; lng: number }[]): LatLngBox | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat, maxLat, minLng, maxLng };
}

/** 사각형의 가운데 */
export function boxCenter(box: LatLngBox): { lat: number; lng: number } {
  return { lat: (box.minLat + box.maxLat) / 2, lng: (box.minLng + box.maxLng) / 2 };
}

/**
 * 즐겨찾기 모아 보기의 후보 — 담은 곳 중 켜 둔 게임이 **모두** 있는 곳.
 * 지도 범위 · 거리 · 검색어와는 상관없다 (F-20: 부산으로 옮기면 사라지던 문제).
 */
export function favoritesPool<T extends { id: number; machines: { id: number }[] }>(
  all: readonly T[],
  favoriteIds: ReadonlySet<number>,
  machineIds: readonly number[],
): T[] {
  return all.filter(
    (a) =>
      favoriteIds.has(a.id) &&
      machineIds.every((id) => a.machines.some((m) => m.id === id)),
  );
}
