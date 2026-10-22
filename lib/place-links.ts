/**
 * 오락실 상세에서 네이버 지도 · 카카오맵으로 넘기는 링크.
 *
 * 영업시간 · 전화 · 길찾기는 우리가 채우지 못합니다. 네이버 지역검색 API 응답에는
 * 영업시간 칸이 없고 전화는 비어서 오며(docs/DATA-SOURCES.md), 공공데이터에도 없습니다.
 * 그래서 개발 DB 926곳 중 영업시간이 있는 곳은 1곳, 전화는 0곳입니다(2026-10-21).
 * 지도 앱들은 그 정보를 업주와 이용자가 매일 고치고 있으니, 우리가 낡은 사본을 들고
 * 있기보다 그쪽 장소 화면으로 보내는 편이 정확합니다 (2026-10-22 첫 사용자 점검).
 *
 * 장소 id 는 없습니다 — 수입할 때 받은 것이 좌표·주소·상호뿐이라, **상호 + 시·군·구**로
 * 검색하는 링크를 만듭니다. 길찾기는 좌표가 있으니 카카오맵의 목적지 링크로 바로 엽니다.
 * URL 형식은 카카오맵 웹 링크 안내(map.kakao.com/link/…)와 네이버 지도 웹 검색 주소
 * (map.naver.com/p/search/…)를 따릅니다.
 *
 * lib/naver-local.ts 의 mapSearchUrl 과 주소 형식은 같지만 그것을 쓰지 않습니다. 그쪽은
 * 상호 + **주소 전체**("… 월드코아 106호 (중동)")라 층·호수·괄호까지 검색어가 되고, 무엇보다
 * 수입 데이터의 자연 키(source_ref)라서 검색이 잘 되게 고치면 릴리스의 대조가 깨집니다.
 * 키는 키대로 두고, 사람이 누를 링크는 여기서 따로 만듭니다.
 *
 * 순수 함수만 둡니다 — 클라이언트 번들에 들어갑니다.
 */

import { regionOf } from './region-cluster';

export interface PlaceLinks {
  /** 네이버 지도에서 이 오락실을 검색 */
  naver: string;
  /** 카카오맵에서 이 오락실을 검색 */
  kakao: string;
  /** 카카오맵 길찾기 — 목적지가 이 좌표로 잡힌 채 열린다 */
  directions: string;
}

/**
 * 상호에서 검색을 흐리는 꼬리를 뗍니다.
 *
 * 공공데이터 상호에는 "대빵오락실(구:짱오락실2023.3.2._상호변경)" 처럼 행정 메모가
 * 괄호로 붙어 옵니다. 그대로 검색하면 지도 앱이 아무것도 못 찾습니다.
 */
export function searchableName(name: string): string {
  const cleaned = name.replace(/\s*[(（[][^)）\]]*[)）\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || name.trim();
}

/**
 * 검색어에 붙일 지역 — "서울 동작구" · "부천시 원미구" · "대구 북구".
 *
 * 상호만으로는 지점이 갈리지 않습니다("대빵오락실" 은 서울에만 여럿). 시·도까지 붙이면
 * '북구' 가 대구·부산·울산·광주 어느 것인지도 갈립니다. 동(읍·면·동)은 붙이지 않습니다 —
 * 도로명 주소의 괄호 동은 지도 앱의 행정동과 어긋나는 일이 잦아 오히려 검색을 흐립니다.
 * 주소를 못 읽으면 앞 두 낱말로 물러섭니다.
 */
export function addressArea(address: string): string {
  const region = regionOf(address);
  if (!region) return address.trim().split(/\s+/).slice(0, 2).join(' ');
  const parts =
    region.city.key === region.province.key ? [region.province.label] : [region.city.label];
  if (region.districtBy === 'gu' && region.district) parts.push(region.district.label);
  return parts.join(' ');
}

export function placeLinks(arcade: {
  name: string;
  address: string;
  lat: number;
  lng: number;
}): PlaceLinks {
  const name = searchableName(arcade.name);
  const query = encodeURIComponent(`${name} ${addressArea(arcade.address)}`.trim());
  // 카카오 목적지 링크는 쉼표로 "이름,위도,경도" 를 가른다 — 이름의 쉼표는 공백으로.
  const label = encodeURIComponent(name.replace(/,/g, ' '));
  return {
    naver: `https://map.naver.com/p/search/${query}`,
    kakao: `https://map.kakao.com/link/search/${query}`,
    directions: `https://map.kakao.com/link/to/${label},${arcade.lat},${arcade.lng}`,
  };
}
