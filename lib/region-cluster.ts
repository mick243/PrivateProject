/**
 * 지도를 멀리서 볼 때 오락실을 **행정구역 단위로** 묶습니다.
 *
 * 왜 거리 기반(격자·반경) 클러스터가 아닌가: 줌을 뺄수록 점 수백 개가 한데 뭉쳐
 * 어디가 어디인지 못 읽게 되는데, 격자로 묶으면 "이 묶음 38" 이 어느 동네인지
 * 말해 주지 못합니다. 이 서비스의 질문은 "우리 구에 몇 곳 있나" · "부산엔 몇 곳이나"
 * 라서 묶음의 이름이 곧 답입니다. 그리고 격자는 지도를 조금 끌 때마다 경계가 바뀌어
 * 숫자가 흔들리지만, 행정구역은 어디서 보든 같습니다.
 *
 * 구역은 **주소 문자열에서** 읽습니다. DB 에 시·도나 법정동 코드 칸이 없고, 주소는
 * 공공데이터·네이버 어느 쪽에서 왔든 "시·도 시·군·구 …" 로 시작합니다
 * (2026-09-30 개발 DB 926곳 전부).
 */

import { distanceKm, type Coord, type LatLngBox } from './geo';

// ─── 줌 → 묶는 단위 ───────────────────────────────────────────

export type ClusterLevel = 'province' | 'city' | 'district';

/**
 * 네이버 지도 줌은 6(전국) ~ 21(건물)이고, 확대·축소 슬라이더 한 칸이 줌 한 단계다
 * (2026-09-30 실측 — 슬라이더 16칸). 네이버 범례로는 줌 10 이 '시,군,구', 줌 7 이 '시,도'.
 *
 *   줌 14 이상  — 묶지 않는다. 오락실 하나하나가 점으로 보인다
 *   줌 13       — 구 · 동 (이름 + 개수)
 *   줌 10 ~ 12  — 구 · 동 (개수만, 가까운 셋을 하나로 — COUNT_ONLY_MAX_ZOOM)
 *   줌 9        — 시 · 광역시
 *   줌 8 이하   — 도 · 특별시
 *
 * 처음(2026-09-30 오후)에는 구·동이 줌 10 하나뿐이었다. 써 보니 줌 11~13 에서 점이
 * 수백 개 깔려 구·동 단위를 넓히고, 넓힌 줌 10~12 에서는 이름표가 서로 덮여 숫자만
 * 남기기로 했다.
 */
export const CLUSTER_MAX_ZOOM: Readonly<Record<ClusterLevel, number>> = {
  district: 13,
  city: 9,
  province: 8,
};

/** 구 · 동 묶음을 이 줌까지는 **개수만** 띄우고 가까운 셋씩 합친다 (mergeNearestClusters) */
export const COUNT_ONLY_MAX_ZOOM = 12;

/** 이 줌에서 무엇으로 묶는지. null 이면 묶지 않는다 (점 하나하나) */
export function clusterLevelForZoom(zoom: number): ClusterLevel | null {
  if (zoom <= CLUSTER_MAX_ZOOM.province) return 'province';
  if (zoom <= CLUSTER_MAX_ZOOM.city) return 'city';
  if (zoom <= CLUSTER_MAX_ZOOM.district) return 'district';
  return null;
}

/** 이 줌의 이 단위를 이름 없이 개수만 띄우는지 (그때는 가까운 셋을 합친다) */
export function isCountOnly(level: ClusterLevel, zoom: number): boolean {
  return level === 'district' && zoom <= COUNT_ONLY_MAX_ZOOM;
}

/**
 * 묶음을 누르면 **적어도** 여기까지는 당긴다.
 * 도 · 특별시와 시 · 광역시는 한 단계 안쪽 단위가 보이는 줌까지, 구 · 동(줌 10~13 에
 * 걸쳐 있다)은 지금보다 한 칸 — 줌 13 에서 누르면 점이 보이는 14 가 된다.
 */
function zoomFloorFor(level: ClusterLevel, currentZoom: number): number {
  const inside =
    level === 'province'
      ? CLUSTER_MAX_ZOOM.province + 1
      : level === 'city'
        ? CLUSTER_MAX_ZOOM.city + 1
        : 0;
  return Math.max(Math.floor(currentZoom) + 1, inside);
}

// ─── 주소 → 구역 ──────────────────────────────────────────────

/** 묶음 하나의 이름표 */
export interface RegionUnit {
  /**
   * 같은 묶음인지 가르는 열쇠. 상위 이름까지 붙인다 — '중구' 는 서울에도 부산에도
   * 있고 '남구' 는 포항시에도 울산에도 있다.
   */
  key: string;
  /** 지도에 찍는 이름 — '서울' · '수원시' · '영통구' · '야당동' */
  label: string;
}

export interface RegionPath {
  /** 도 · 특별시 (시·도) */
  readonly province: RegionUnit;
  /** 시 · 광역시 — 서울·광역시·세종은 시·도 그 자체, 도 안에서는 시·군 */
  readonly city: RegionUnit;
  /**
   * 구 · 동 — 구가 있으면 구(자치구·일반구), 없으면 읍·면·동.
   * null 이면 주소에서 그 단위를 못 읽은 것이다 (괄호를 뺀 도로명 주소 — findDong).
   */
  readonly district: RegionUnit | null;
  /** district 를 무엇으로 갈랐나. 'gu' 는 자치구·군·일반구, 'dong' 은 읍·면·동 */
  readonly districtBy: 'gu' | 'dong' | null;
}

/**
 * 줄여 쓴 시·도 이름과 **옛 이름**을 지금 이름으로.
 *
 * 수집한 주소는 전부 정식 이름이지만, 사용자가 등록 폼에 직접 쓴 주소는 "서울 강남구"
 * 처럼 줄여 쓰기 쉽다. 그걸 따로 두면 서울 묶음이 둘이 된다.
 *
 * 옛 이름은 바뀐 뒤의 이름으로 모은다 — 개발 DB 에 광주광역시·전라남도는 한 곳도
 * 없고 광산구·여수시가 모두 '전남광주통합특별시' 아래에 있다. 강원도·전라북도도
 * 특별자치도로 바뀐 뒤다.
 */
const SIDO_ALIASES: Readonly<Record<string, string>> = {
  서울: '서울특별시',
  서울시: '서울특별시',
  부산: '부산광역시',
  부산시: '부산광역시',
  대구: '대구광역시',
  대구시: '대구광역시',
  인천: '인천광역시',
  인천시: '인천광역시',
  대전: '대전광역시',
  대전시: '대전광역시',
  울산: '울산광역시',
  울산시: '울산광역시',
  세종: '세종특별자치시',
  세종시: '세종특별자치시',
  경기: '경기도',
  강원: '강원특별자치도',
  강원도: '강원특별자치도',
  충북: '충청북도',
  충남: '충청남도',
  전북: '전북특별자치도',
  전라북도: '전북특별자치도',
  광주: '전남광주통합특별시',
  광주시: '전남광주통합특별시',
  광주광역시: '전남광주통합특별시',
  전남: '전남광주통합특별시',
  전라남도: '전남광주통합특별시',
  경북: '경상북도',
  경남: '경상남도',
  제주: '제주특별자치도',
  제주도: '제주특별자치도',
};

/** 지도에 찍을 짧은 시·도 이름. 없는 이름은 꼬리('…도' · '…광역시')만 떼어 쓴다 */
const SIDO_SHORT: Readonly<Record<string, string>> = {
  서울특별시: '서울',
  부산광역시: '부산',
  대구광역시: '대구',
  인천광역시: '인천',
  대전광역시: '대전',
  울산광역시: '울산',
  세종특별자치시: '세종',
  경기도: '경기',
  강원특별자치도: '강원',
  충청북도: '충북',
  충청남도: '충남',
  전북특별자치도: '전북',
  전남광주통합특별시: '전남광주',
  경상북도: '경북',
  경상남도: '경남',
  제주특별자치도: '제주',
};

/**
 * 도 · 특별시 묶음을 찍을 자리 (대략 그 시·도의 한가운데).
 *
 * 속한 오락실의 평균 좌표를 쓰면 **경기 묶음이 서울 묶음에 겹친다** — 경기의
 * 오락실은 서울을 고리처럼 둘러싸고 있어서 평균이 서울 바로 밑으로 떨어진다
 * (2026-09-30 실측 37.455, 127.006 · 서울 평균에서 11km = 줌 8 에서 23px).
 * 그래서 이 단위만은 정해 둔 자리에 찍는다.
 *
 * 전국이 한 화면에 드는 줌 7 에서도 16곳 이름표가 서로 안 겹치게 조금씩 비켰다 —
 * 인천은 서해 섬 쪽(남서)으로, 세종은 조치원 쪽(북)으로, 대전은 남으로, 충남은
 * 서산 쪽(서)으로. 모든 곳이 세 자리 수(가장 넓은 이름표)여도 안 겹친다
 * (tests/region-cluster.test.ts 가 줌 7·8 에서 확인한다).
 * 여기 없는 시·도(새로 생긴 이름)는 평균 좌표로 간다.
 */
const PROVINCE_ANCHORS: Readonly<Record<string, Coord>> = {
  서울특별시: { lat: 37.5665, lng: 126.978 },
  인천광역시: { lat: 37.33, lng: 126.5 },
  경기도: { lat: 37.29, lng: 127.36 },
  강원특별자치도: { lat: 37.75, lng: 128.3 },
  충청북도: { lat: 36.83, lng: 127.7 },
  충청남도: { lat: 36.55, lng: 126.45 },
  세종특별자치시: { lat: 36.6, lng: 127.31 },
  대전광역시: { lat: 36.32, lng: 127.4 },
  전북특별자치도: { lat: 35.72, lng: 127.15 },
  전남광주통합특별시: { lat: 34.95, lng: 126.95 },
  경상북도: { lat: 36.4, lng: 128.75 },
  대구광역시: { lat: 35.8714, lng: 128.6014 },
  경상남도: { lat: 35.3, lng: 128.2 },
  울산광역시: { lat: 35.5384, lng: 129.3114 },
  부산광역시: { lat: 35.1796, lng: 129.0756 },
  제주특별자치도: { lat: 33.4, lng: 126.55 },
};

/**
 * 도 안인데 시·군을 거치지 않고 바로 붙은 자치구 → 그 구들이 이루는 도시.
 *
 * 전남광주통합특별시의 광산구·동구·서구·남구·북구는 옛 광주광역시다. '시 · 광역시'
 * 단위에서 그 다섯을 따로 두면 광주 한 도시가 묶음 다섯 개로 쪼개진다.
 */
const DIRECT_GU_CITY: Readonly<Record<string, string>> = {
  전남광주통합특별시: '광주',
};

/** 시·도 이름이 그 자체로 한 도시인지 — 서울 · 광역시 · 세종 */
function isCitySido(sido: string): boolean {
  return /(광역시|특별자치시)$/.test(sido) || (/특별시$/.test(sido) && !/통합특별시$/.test(sido));
}

function shortSido(sido: string): string {
  return SIDO_SHORT[sido] ?? sido.replace(/(특별자치도|특별자치시|통합특별시|특별시|광역시|도)$/, '');
}

const SIDO_RE = /(특별시|광역시|특별자치시|특별자치도|도)$/;
const SIGUNGU_RE = /^[가-힣]+(시|군|구)$/;
const GU_RE = /^[가-힣]+구$/;
const EUP_MYEON_RE = /^[가-힣0-9]+(읍|면)$/;
/** 법정동 — '행당동' · '종로1가' · '신흑동'. 건물 동('B동' · '101동')은 한글로만 시작하지 않아 걸러진다 */
const DONG_RE = /^[가-힣]+[0-9]*(동|가)$/;
/** 지번 — '산16-4' · '123-4' · '12' */
const JIBUN_RE = /^산?[0-9]/;

/**
 * 시·군 아래 **구가 없을 때** 한 단계 안쪽(읍·면·동)을 주소에서 찾는다.
 *
 * 도로명 주소는 읍·면이면 길 이름 앞에 쓰고("증평군 증평읍 윗장뜰길 60"), 동이면
 * 끝의 괄호에 쓴다("파주시 와석순환로 86, 101호 (야당동)"). 지번 주소는 동을 바로
 * 쓴다("삼척시 갈천동 산16-4"). 괄호를 빼먹은 도로명 주소에는 동이 없다 — 그때는
 * null. 개발 DB 에서 구가 없는 시·군의 오락실 408곳 중 170곳이 그렇다 (2026-09-30).
 */
function findDong(rest: readonly string[], address: string): string | null {
  const first = rest[0];
  if (first && EUP_MYEON_RE.test(first)) return first;
  if (first && DONG_RE.test(first) && rest[1] !== undefined && JIBUN_RE.test(rest[1])) return first;

  const paren = /\(([^()]*)\)\s*$/.exec(address);
  const inParen = paren?.[1].split(',')[0]?.trim();
  if (inParen && DONG_RE.test(inParen)) return inParen;
  return null;
}

/**
 * 주소 → 도·특별시 / 시·광역시 / 구·동 세 단위.
 *
 * 첫 낱말이 시·도로 읽히지 않으면 null — 그런 오락실은 묶지 않고 점으로 남긴다
 * (clusterByRegion 의 loose). 엉뚱한 묶음에 넣는 것보다 낫다.
 */
export function regionOf(address: string): RegionPath | null {
  const tokens = address.trim().split(/\s+/);
  const head = tokens[0] ?? '';
  const sido = SIDO_ALIASES[head] ?? head;
  if (!SIDO_RE.test(sido)) return null;

  const province: RegionUnit = { key: sido, label: shortSido(sido) };
  const second = tokens[1];
  const sigungu = second && SIGUNGU_RE.test(second) ? second : null;

  /** 구가 없는 곳 — 읍·면·동으로 가르거나, 못 읽으면 null */
  const byDong = (city: RegionUnit, rest: readonly string[]): RegionPath => {
    const dong = findDong(rest, address);
    return dong
      ? { province, city, district: { key: `${city.key}|${dong}`, label: dong }, districtBy: 'dong' }
      : { province, city, district: null, districtBy: null };
  };
  const byGu = (city: RegionUnit, gu: string): RegionPath => ({
    province,
    city,
    district: { key: `${city.key}|${gu}`, label: gu },
    districtBy: 'gu',
  });

  if (isCitySido(sido)) {
    // 서울 · 광역시 · 세종 — 시·도가 곧 도시이고, 그 안의 자치구·군이 가장 안쪽이다.
    // 세종은 시·군·구가 없다 — "세종특별자치시 나성로 133-15".
    return sigungu ? byGu(province, sigungu) : byDong(province, tokens.slice(1));
  }

  // 도 · 특별자치도 · 통합특별시
  if (!sigungu) return { province, city: province, district: null, districtBy: null };

  if (GU_RE.test(sigungu)) {
    // 도 아래 바로 붙은 자치구 (전남광주통합특별시 광산구 — 옛 광주광역시)
    const cityName = DIRECT_GU_CITY[sido] ?? sigungu;
    return byGu({ key: `${sido}|${cityName}`, label: cityName }, sigungu);
  }

  const city: RegionUnit = { key: `${sido}|${sigungu}`, label: sigungu };
  const third = tokens[2];
  // 일반구가 있는 시 — "수원시 영통구", "창원시 마산합포구"
  if (sigungu.endsWith('시') && third && GU_RE.test(third)) return byGu(city, third);
  return byDong(city, tokens.slice(2));
}

/**
 * 주소마다 한 번만 읽는다.
 *
 * 목록을 다시 받으면 오락실 객체는 전부 새것이지만 주소 문자열은 대개 그대로다.
 * 객체를 열쇠로 쓰면 그때마다 926곳을 다시 읽는다.
 */
const regionCache = new Map<string, RegionPath | null>();

function cachedRegionOf(address: string): RegionPath | null {
  let hit = regionCache.get(address);
  if (hit === undefined) {
    hit = regionOf(address);
    regionCache.set(address, hit);
  }
  return hit;
}

// ─── 묶기 ─────────────────────────────────────────────────────

export interface RegionCluster {
  key: string;
  label: string;
  level: ClusterLevel;
  /** 묶음을 찍을 자리 */
  lat: number;
  lng: number;
  count: number;
  /** 속한 오락실들을 담는 사각형 — 누르면 여기로 당긴다 */
  bounds: LatLngBox;
}

export interface ClusterableArcade extends Coord {
  id: number;
  address: string;
}

/**
 * 오락실을 한 단위로 묶는다.
 *
 * 받은 목록 **전부**를 묶는다 (화면 안만 묶지 않는다). 화면 안만 묶으면 지도를 끌
 * 때마다 한 구의 숫자와 자리가 바뀐다 — 경계에 걸친 구는 반쪽만 세어진다.
 * 그리는 것만 화면 안으로 자르면 된다 (components/NaverMap.tsx).
 *
 * 구 · 동 단위에서 동을 못 읽은 곳이 섞이면:
 *   - 구가 없는 시·군이면 **그 시·군을 통째로** 한 묶음으로 둔다. "단계동 3 · 무실동 2
 *     · 원주시 4" 처럼 두면 마지막 묶음이 원주 전체가 4곳인 것처럼 읽힌다.
 *   - 구가 있는 곳(서울 등)에서 구가 빠진 주소는 그 한 곳만 점으로 남긴다 — 그 한 곳
 *     때문에 서울 전체를 한 덩어리로 되돌릴 수는 없다.
 *
 * `loose` 는 묶지 못한 오락실 — 점으로 그린다.
 */
export function clusterByRegion<T extends ClusterableArcade>(
  arcades: readonly T[],
  level: ClusterLevel,
): { clusters: RegionCluster[]; loose: T[] } {
  const groups = new Map<
    string,
    { unit: RegionUnit; sumLat: number; sumLng: number; count: number; box: LatLngBox }
  >();
  const loose: T[] = [];

  // 구 · 동 단위: 도시마다 구로 갈리는지, 동을 못 읽은 곳이 있는지 먼저 본다.
  const guCities = new Set<string>();
  const unreadCities = new Set<string>();
  if (level === 'district') {
    for (const a of arcades) {
      const region = cachedRegionOf(a.address);
      if (!region) continue;
      if (region.districtBy === 'gu') guCities.add(region.city.key);
      else if (!region.district) unreadCities.add(region.city.key);
    }
  }

  for (const a of arcades) {
    const region = cachedRegionOf(a.address);
    let unit: RegionUnit | null = null;
    if (region && level !== 'district') unit = region[level];
    else if (region) {
      const cityKey = region.city.key;
      // 구로 갈리는 도시에서 구가 빠진 주소는 동을 읽었더라도 점으로 — 구 묶음들
      // 사이에 동 하나가 끼면 단위가 섞인다.
      if (guCities.has(cityKey)) unit = region.districtBy === 'gu' ? region.district : null;
      else unit = unreadCities.has(cityKey) ? region.city : region.district;
    }
    if (!unit) {
      loose.push(a);
      continue;
    }
    const g = groups.get(unit.key);
    if (g) {
      g.sumLat += a.lat;
      g.sumLng += a.lng;
      g.count += 1;
      g.box.minLat = Math.min(g.box.minLat, a.lat);
      g.box.maxLat = Math.max(g.box.maxLat, a.lat);
      g.box.minLng = Math.min(g.box.minLng, a.lng);
      g.box.maxLng = Math.max(g.box.maxLng, a.lng);
    } else {
      groups.set(unit.key, {
        unit,
        sumLat: a.lat,
        sumLng: a.lng,
        count: 1,
        box: { minLat: a.lat, maxLat: a.lat, minLng: a.lng, maxLng: a.lng },
      });
    }
  }

  const clusters: RegionCluster[] = [];
  for (const g of groups.values()) {
    const anchor = level === 'province' ? PROVINCE_ANCHORS[g.unit.key] : undefined;
    clusters.push({
      key: g.unit.key,
      label: g.unit.label,
      level,
      lat: anchor?.lat ?? g.sumLat / g.count,
      lng: anchor?.lng ?? g.sumLng / g.count,
      count: g.count,
      bounds: g.box,
    });
  }
  return { clusters, loose };
}

// ─── 이름표 배치 ─────────────────────────────────────────────

/** 웹 메르카토르 y (0~1). 위도가 높을수록 같은 도(°)가 더 길게 그려진다 */
function mercatorY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** 이 줌에서의 세계 픽셀 좌표 (256px 타일 — 네이버도 같다) */
function worldPx(p: Coord, zoom: number): { x: number; y: number } {
  const scale = 256 * 2 ** zoom;
  return { x: ((p.lng + 180) / 360) * scale, y: mercatorY(p.lat) * scale };
}

/**
 * 묶음 이름표의 크기 어림 (px). app/globals.css 의 `.mk-cluster` 치수를 옮긴 것이다 —
 * 그쪽을 고치면 여기도 고친다.
 *
 * DOM 을 재지 않는 이유: 재려면 먼저 붙여야 하고, 붙인 뒤에 겹친 것을 다시 고치면
 * 한 번 그린 것을 또 그린다. 글자 수로 어림해도 겹침 판정에는 충분하다
 * (한글 12px 한 자 ≈ 12px, 숫자 11px 한 자 ≈ 7px).
 */
export function estimateLabelBox(label: string, count: number, compact: boolean) {
  const chip = Math.max(18, 10 + 7 * String(count).length);
  const h = 24;
  if (compact) return { w: chip + 8, h };
  return { w: 9 + 12 * label.length + 5 + chip + 5, h };
}

/**
 * 이름을 다 띄울 묶음을 고른다 — 나머지는 숫자만 띄운다 (가리키면 이름이 나온다).
 * 이름을 띄우는 줌(구 · 동 13 · 시 9 · 도 8 이하)에서만 쓴다.
 *
 * 지도 이름표가 흔히 하는 대로, **오락실이 많은 곳부터** 자리를 잡고 이미 잡힌 자리에
 * 걸리는 것은 줄여서 띄운다. 빼 버리지는 않는다 — 묶음이 사라지면 그 구의 오락실이
 * 지도에서 없어진 것처럼 보인다.
 *
 * 2026-09-30 개발 DB 로 잰 것: 구 · 동을 줌 10 에서 이름까지 띄우면 241개 중 114쌍이
 * 겹쳤다(서울 전체가 폭 300px 남짓) — 그래서 줌 10~12 는 아예 숫자만 띄운다
 * (isCountOnly). 줌 13 에서는 241개가 다 뜨고, 시 · 광역시(줌 9)는 132개 중 109개가 뜬다.
 */
export function layoutClusterLabels(
  clusters: readonly RegionCluster[],
  zoom: number,
): Set<string> {
  const order = [...clusters].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const labeled = new Set<string>();
  const hits = (b: (typeof placed)[number]) =>
    placed.some((p) => b.x0 < p.x1 && p.x0 < b.x1 && b.y0 < p.y1 && p.y0 < b.y1);

  for (const c of order) {
    const at = worldPx(c, zoom);
    const boxOf = (compact: boolean) => {
      const { w, h } = estimateLabelBox(c.label, c.count, compact);
      return { x0: at.x - w / 2, x1: at.x + w / 2, y0: at.y - h / 2, y1: at.y + h / 2 };
    };
    const full = boxOf(false);
    if (!hits(full)) {
      placed.push(full);
      labeled.add(c.key);
    } else {
      // 줄인 것도 자리를 차지한다 — 뒤에 오는 더 작은 묶음이 그 위에 이름을 펴지 않게.
      placed.push(boxOf(true));
    }
  }
  return labeled;
}

// ─── 개수만 띄울 때: 가까운 셋을 하나로 ───────────────────────

/** 몇 개씩 합치나 — 자기 자신 + 가장 가까운 둘 */
const MERGE_SIZE = 3;

/**
 * 이만큼(km) 안에 있는 것끼리만 합친다.
 *
 * 한도가 없으면 외딴 곳(울릉군 · 섬 지역)이 수십 km 떨어진 묶음과 합쳐져, 그 사이
 * 바다 위에 숫자가 찍힌다. 서울 25개 구는 두 번째로 가까운 이웃이 전부 5.3km 안에
 * 있다. 6km 로 두면 전국 241개가 181개로, 서울은 11개(셋 7 · 둘 3 · 하나 1)로 줄고,
 * 줌 10 에서 숫자끼리 겹치던 35쌍이 0 이 된다 (2026-09-30 개발 DB).
 *
 * 화면 거리(px)가 아니라 땅 위 거리로 재는 이유: 그래야 줌 10 · 11 · 12 에서 **같은
 * 묶음**이 나온다. px 로 재면 줌을 한 칸 바꿀 때마다 짝이 바뀌어 숫자가 뒤섞인다.
 */
export const MERGE_RADIUS_KM = 6;

/**
 * 구 · 동 묶음을 가까운 셋씩 하나로 합친다 (줌 10~12 — 개수만 띄우는 줌).
 *
 * 오락실이 많은 묶음부터 차례로, 아직 안 합쳐진 것 중 가장 가까운 둘(MERGE_RADIUS_KM
 * 안)을 끌어온다. 합친 묶음의 자리는 속한 오락실 전체의 평균이고, 누르면 셋을 다 담는
 * 범위로 당긴다. 가까운 게 없으면 혼자 남는다.
 */
export function mergeNearestClusters(clusters: readonly RegionCluster[]): RegionCluster[] {
  const order = [...clusters].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const taken = new Set<string>();
  const out: RegionCluster[] = [];

  for (const seed of order) {
    if (taken.has(seed.key)) continue;
    taken.add(seed.key);
    const near = order
      .filter((c) => !taken.has(c.key))
      .map((c) => ({ c, d: distanceKm(seed, c) }))
      .filter((e) => e.d <= MERGE_RADIUS_KM)
      .sort((a, b) => a.d - b.d || a.c.key.localeCompare(b.c.key))
      .slice(0, MERGE_SIZE - 1)
      .map((e) => e.c);
    if (near.length === 0) {
      out.push(seed);
      continue;
    }
    for (const c of near) taken.add(c.key);

    const group = [seed, ...near];
    const count = group.reduce((n, c) => n + c.count, 0);
    out.push({
      // 열쇠는 속한 묶음들의 열쇠 — 같은 셋이면 같은 열쇠라 지도가 마커를 다시 만들지 않는다
      key: group
        .map((c) => c.key)
        .sort()
        .join('+'),
      label: group.map((c) => c.label).join(' · '),
      level: seed.level,
      lat: group.reduce((s, c) => s + c.lat * c.count, 0) / count,
      lng: group.reduce((s, c) => s + c.lng * c.count, 0) / count,
      count,
      bounds: {
        minLat: Math.min(...group.map((c) => c.bounds.minLat)),
        maxLat: Math.max(...group.map((c) => c.bounds.maxLat)),
        minLng: Math.min(...group.map((c) => c.bounds.minLng)),
        maxLng: Math.max(...group.map((c) => c.bounds.maxLng)),
      },
    });
  }
  return out;
}

// ─── 누르면 어디까지 당기나 ───────────────────────────────────

/** 이보다 더 당기지 않는다 — 한 곳짜리 묶음을 누르면 건물 수준까지 파고든다 */
const FIT_MAX_ZOOM = 15;

/**
 * 이 사각형이 화면(px)에 다 들어가는 가장 큰 줌. 256px 타일 기준 (네이버도 같다).
 *
 * `fitBounds` 를 쓰지 않는 이유: 그건 **사각형만** 본다. 경기 전체를 담으면 줌 8 이
 * 나와 누르기 전과 같은 도 단위에 머문다 — 눌렀는데 아무 일도 없는 것처럼 보인다.
 * 그래서 줌을 직접 셈해 "한 단계 안쪽" 과 견준다 (zoomForCluster).
 */
export function zoomToFit(box: LatLngBox, widthPx: number, heightPx: number): number {
  const lngFrac = Math.max((box.maxLng - box.minLng) / 360, 1e-9);
  const latFrac = Math.max(mercatorY(box.minLat) - mercatorY(box.maxLat), 1e-9);
  const zx = Math.log2(widthPx / 256 / lngFrac);
  const zy = Math.log2(heightPx / 256 / latFrac);
  return Math.floor(Math.min(zx, zy));
}

/**
 * 묶음을 눌렀을 때 갈 줌 — 속한 오락실이 다 보이게, 단 **적어도 한 단계 안쪽**까지
 * (zoomFloorFor). 여백을 조금 두고 맞춘다 (가장자리 점이 화면 끝에 붙지 않게).
 */
export function zoomForCluster(
  cluster: Pick<RegionCluster, 'level' | 'bounds'>,
  widthPx: number,
  heightPx: number,
  currentZoom: number,
): number {
  const fit = zoomToFit(cluster.bounds, widthPx * 0.8, heightPx * 0.8);
  return Math.min(FIT_MAX_ZOOM, Math.max(zoomFloorFor(cluster.level, currentZoom), fit));
}
