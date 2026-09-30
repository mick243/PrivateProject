import { describe, expect, it } from 'vitest';
import {
  clusterByRegion,
  clusterLevelForZoom,
  layoutClusterLabels,
  regionOf,
  zoomForCluster,
  zoomToFit,
} from '@/lib/region-cluster';

describe('clusterLevelForZoom — "N단계 축소" = 줌 21 − N', () => {
  it('10단계(줌 11) 까지는 묶지 않는다', () => {
    expect(clusterLevelForZoom(21)).toBeNull();
    expect(clusterLevelForZoom(12)).toBeNull();
    expect(clusterLevelForZoom(11)).toBeNull();
  });

  it('11단계(줌 10) 는 구·동, 12단계(줌 9) 는 시·광역시', () => {
    expect(clusterLevelForZoom(10)).toBe('district');
    expect(clusterLevelForZoom(9)).toBe('city');
  });

  it('13단계(줌 8) 부터 끝(줌 6)까지 도·특별시', () => {
    expect(clusterLevelForZoom(8)).toBe('province');
    expect(clusterLevelForZoom(7)).toBe('province');
    expect(clusterLevelForZoom(6)).toBe('province');
  });
});

/** 세 단위의 이름표만 뽑아 본다 */
const labels = (address: string) => {
  const r = regionOf(address);
  return r && [r.province.label, r.city.label, r.district?.label ?? null];
};

describe('regionOf — 주소에서 세 단위', () => {
  it('서울 · 광역시는 시·도가 곧 도시이고 그 안이 자치구', () => {
    expect(labels('서울특별시 강동구 천호대로157길 14')).toEqual(['서울', '서울', '강동구']);
    expect(labels('부산광역시 수영구 민락수변로 7, OK타운 1층 101호 (민락동)')).toEqual([
      '부산',
      '부산',
      '수영구',
    ]);
    // 광역시의 군은 군 그대로 (읍·면으로 내려가지 않는다)
    expect(labels('대구광역시 달성군 다사읍 달구벌대로 1')).toEqual(['대구', '대구', '달성군']);
  });

  it('도 안의 시는 일반구가 있으면 구로', () => {
    expect(labels('경기도 수원시 영통구 광교로 1')).toEqual(['경기', '수원시', '영통구']);
    expect(labels('경상남도 창원시 마산합포구 3·15대로 1')).toEqual(['경남', '창원시', '마산합포구']);
  });

  it('구가 없으면 읍·면·동으로 — 읍·면은 길 이름 앞, 동은 끝의 괄호, 지번은 바로', () => {
    expect(labels('충청북도 증평군 증평읍 윗장뜰길 60 1층 101호')).toEqual(['충북', '증평군', '증평읍']);
    expect(labels('경기도 파주시 와석순환로 86, 101호 (야당동)')).toEqual(['경기', '파주시', '야당동']);
    expect(labels('충청북도 청주시 흥덕구 풍년로 148-1, 1층 (가경동)')).toEqual([
      '충북',
      '청주시',
      '흥덕구',
    ]);
    expect(labels('강원특별자치도 삼척시 갈천동 산16-4')).toEqual(['강원', '삼척시', '갈천동']);
    expect(labels('서울특별시 종로구 종로 1 (종로1가)')?.[2]).toBe('종로구');
  });

  it('괄호가 없는 도로명 주소는 동을 모른다 (null)', () => {
    expect(labels('강원특별자치도 강릉시 금성로 16')).toEqual(['강원', '강릉시', null]);
    expect(labels('세종특별자치시 나성로 133-15 애플타워')).toEqual(['세종', '세종', null]);
  });

  it('건물 동(A동·101동)은 법정동으로 읽지 않는다', () => {
    expect(labels('경기도 김포시 김포한강9로 87 (B동)')?.[2]).toBeNull();
    expect(labels('경기도 김포시 김포한강9로 87 (대림아파트 101동)')?.[2]).toBeNull();
  });

  it('전남광주통합특별시에 바로 붙은 자치구는 옛 광주광역시로 묶는다', () => {
    expect(labels('전남광주통합특별시 광산구 첨단중앙로 1')).toEqual(['전남광주', '광주', '광산구']);
    expect(labels('전남광주통합특별시 여수시 좌수영로 1')?.slice(0, 2)).toEqual(['전남광주', '여수시']);
  });

  it('줄여 쓴 이름·옛 이름은 지금 이름으로 모은다', () => {
    expect(regionOf('서울 강남구 테헤란로 1')?.district?.key).toBe(
      regionOf('서울특별시 강남구 테헤란로 1')?.district?.key,
    );
    expect(regionOf('광주광역시 광산구 첨단중앙로 1')?.city.key).toBe(
      regionOf('전남광주통합특별시 광산구 첨단중앙로 1')?.city.key,
    );
    expect(regionOf('강원도 강릉시 금성로 16')?.province.key).toBe('강원특별자치도');
  });

  it('시·도로 시작하지 않는 주소는 읽지 않는다', () => {
    expect(regionOf('강남역 11번 출구 앞')).toBeNull();
    expect(regionOf('')).toBeNull();
  });
});

const at = (id: number, address: string, lat: number, lng: number) => ({ id, address, lat, lng });

describe('clusterByRegion', () => {
  const sample = [
    at(1, '서울특별시 중구 명동길 1', 37.56, 126.98),
    at(2, '서울특별시 중구 명동길 2', 37.57, 126.99),
    at(3, '부산광역시 중구 중앙대로 1', 35.1, 129.03),
    at(4, '경기도 수원시 영통구 광교로 1', 37.28, 127.05),
    at(5, '경기도 수원시 팔달구 정조로 1', 37.28, 127.01),
    at(6, '경기도 파주시 와석순환로 86 (야당동)', 37.71, 126.76),
  ];

  it('이름이 같은 다른 구(서울 중구 · 부산 중구)는 따로 센다', () => {
    const { clusters } = clusterByRegion(sample, 'district');
    const jung = clusters.filter((c) => c.label === '중구');
    expect(jung.map((c) => c.count).sort()).toEqual([1, 2]);
  });

  it('단위마다 개수가 맞는다', () => {
    const count = (level: 'province' | 'city' | 'district') =>
      Object.fromEntries(clusterByRegion(sample, level).clusters.map((c) => [c.key, c.count]));
    expect(count('province')).toEqual({ 서울특별시: 2, 부산광역시: 1, 경기도: 3 });
    expect(count('city')).toEqual({
      서울특별시: 2,
      부산광역시: 1,
      '경기도|수원시': 2,
      '경기도|파주시': 1,
    });
    expect(count('district')).toEqual({
      '서울특별시|중구': 2,
      '부산광역시|중구': 1,
      '경기도|수원시|영통구': 1,
      '경기도|수원시|팔달구': 1,
      '경기도|파주시|야당동': 1,
    });
  });

  it('구가 없는 시에서 동을 못 읽은 곳이 하나라도 있으면 그 시는 통째로 둔다', () => {
    const wonju = [
      at(1, '강원특별자치도 원주시 서원대로 1 (단계동)', 37.35, 127.93),
      at(2, '강원특별자치도 원주시 서원대로 2 (단계동)', 37.35, 127.93),
      at(3, '강원특별자치도 원주시 천사로 56 1층', 37.34, 127.92),
    ];
    const whole = clusterByRegion(wonju, 'district').clusters;
    expect(whole.map((c) => [c.label, c.count])).toEqual([['원주시', 3]]);

    // 다 읽히면 동으로 가른다
    const split = clusterByRegion(wonju.slice(0, 2), 'district').clusters;
    expect(split.map((c) => [c.label, c.count])).toEqual([['단계동', 2]]);
  });

  it('구로 갈리는 도시에서 구가 빠진 주소는 그 한 곳만 점으로 남긴다', () => {
    const { clusters, loose } = clusterByRegion(
      [...sample, at(9, '경기도 수원시 정조로 9 (인계동)', 37.26, 127.03)],
      'district',
    );
    expect(loose.map((a) => a.id)).toEqual([9]);
    expect(clusters.find((c) => c.label === '영통구')?.count).toBe(1);
  });

  it('주소를 못 읽은 곳은 어느 단위에서든 점으로 남긴다', () => {
    const odd = at(7, '주소 미상', 37.5, 127);
    for (const level of ['province', 'city', 'district'] as const) {
      expect(clusterByRegion([...sample, odd], level).loose).toEqual([odd]);
    }
  });

  it('도·특별시는 정해 둔 자리에, 나머지는 속한 곳의 평균에 찍는다', () => {
    const province = clusterByRegion(sample, 'province').clusters.find((c) => c.label === '경기');
    // 경기의 평균(37.42, 126.94)은 서울과 겹친다 — 그 자리를 쓰지 않는다
    expect(province?.lat).not.toBeCloseTo(37.42, 1);
    const city = clusterByRegion(sample, 'city').clusters.find((c) => c.label === '수원시');
    expect(city?.lat).toBeCloseTo(37.28, 5);
    expect(city?.lng).toBeCloseTo(127.03, 5);
    expect(city?.bounds).toEqual({ minLat: 37.28, maxLat: 37.28, minLng: 127.01, maxLng: 127.05 });
  });
});

describe('layoutClusterLabels', () => {
  /** 16개 시·도에 한 곳씩 */
  const everyProvince = [
    '서울특별시 중구 1',
    '부산광역시 중구 1',
    '대구광역시 중구 1',
    '인천광역시 중구 1',
    '대전광역시 중구 1',
    '울산광역시 중구 1',
    '세종특별자치시 나성로 1',
    '경기도 수원시 1',
    '강원특별자치도 춘천시 1',
    '충청북도 청주시 1',
    '충청남도 천안시 1',
    '전북특별자치도 전주시 1',
    '전남광주통합특별시 여수시 1',
    '경상북도 포항시 1',
    '경상남도 창원시 1',
    '제주특별자치도 제주시 1',
  ].map((address, i) => at(i, address, 36, 128));

  it('전국이 한 화면에 드는 줌 7·8 에서 16개 시·도 이름이 모두 뜬다', () => {
    // 개수 자리가 세 자리일 때(가장 넓은 이름표)도 겹치지 않아야 한다
    const { clusters } = clusterByRegion(everyProvince, 'province');
    const wide = clusters.map((c) => ({ ...c, count: 199 }));
    expect(clusters).toHaveLength(16);
    expect(layoutClusterLabels(wide, 7).size).toBe(16);
    expect(layoutClusterLabels(wide, 8).size).toBe(16);
  });

  it('겹치면 오락실이 많은 쪽이 이름을 가져간다', () => {
    const near = [
      at(1, '서울특별시 중구 1', 37.56, 126.98),
      at(2, '서울특별시 종로구 1', 37.57, 126.98),
      at(3, '서울특별시 종로구 2', 37.57, 126.98),
    ];
    const { clusters } = clusterByRegion(near, 'district');
    const labeled = layoutClusterLabels(clusters, 10);
    expect([...labeled]).toEqual(['서울특별시|종로구']);
    // 멀찍이 당기면 둘 다
    expect(layoutClusterLabels(clusters, 16).size).toBe(2);
  });
});

describe('누르면 어디까지 당기나', () => {
  const seoul = { minLat: 37.43, maxLat: 37.7, minLng: 126.76, maxLng: 127.18 };

  it('zoomToFit — 서울 전체(0.42° × 0.27°)는 800×600 화면에서 줌 11', () => {
    // 줌 11 에서 서울 폭 ≈ 612px, 줌 12 면 1224px 로 넘친다
    expect(zoomToFit(seoul, 800, 600)).toBe(11);
    // 화면이 두 배면 한 단계 더
    expect(zoomToFit(seoul, 1600, 1200)).toBe(12);
  });

  it('적어도 한 단계 안쪽까지 — 도를 눌렀는데 도 단위에 머물지 않는다', () => {
    const gyeonggi = { minLat: 36.9, maxLat: 38.2, minLng: 126.4, maxLng: 127.8 };
    // 좁은 지도 칸에서는 경기 전체가 줌 8(도 단위)에서야 들어온다
    expect(zoomToFit(gyeonggi, 400, 300)).toBe(8);
    expect(zoomForCluster({ level: 'province', bounds: gyeonggi }, 400, 300)).toBe(9);
  });

  it('한 곳짜리 묶음은 15 에서 멈춘다', () => {
    const point = { minLat: 37.5, maxLat: 37.5, minLng: 127, maxLng: 127 };
    expect(zoomForCluster({ level: 'district', bounds: point }, 800, 600)).toBe(15);
  });
});
