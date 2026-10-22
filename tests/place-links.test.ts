import { describe, expect, it } from 'vitest';
import { addressArea, placeLinks, searchableName } from '@/lib/place-links';

/**
 * 오락실 상세의 네이버 지도 · 카카오맵 · 길찾기 링크.
 * 장소 id 가 없어 상호 + 지역으로 검색하므로, 검색어가 지도 앱에서 그 지점을 찾을 수
 * 있는 꼴인지가 전부다. 주소 예시는 개발 DB 의 실제 형식이다.
 */

describe('searchableName', () => {
  it('공공데이터 상호의 괄호 메모를 뗀다', () => {
    expect(searchableName('대빵오락실(구:짱오락실2023.3.2._상호변경)')).toBe('대빵오락실');
  });

  it('지점명은 남긴다', () => {
    expect(searchableName('짱오락실 홍대점')).toBe('짱오락실 홍대점');
  });

  it('괄호뿐인 이름은 원래 이름으로 물러선다', () => {
    expect(searchableName('(가칭)')).toBe('(가칭)');
  });
});

describe('addressArea', () => {
  it('서울·광역시는 시·도 + 자치구', () => {
    expect(addressArea('서울특별시 동작구 만양로14가길 26 어뮤즈타운')).toBe('서울 동작구');
    expect(addressArea('대구광역시 북구 동천로 125-3 1층 전체')).toBe('대구 북구');
  });

  it('도 안의 시는 시 + 일반구 — 층·호수·괄호 동은 붙이지 않는다', () => {
    expect(addressArea('경기도 부천시 원미구 중동로254번길 81, 월드코아 106호 (중동)')).toBe(
      '부천시 원미구',
    );
  });

  it('구가 없는 시는 시까지만', () => {
    expect(addressArea('경기도 파주시 와석순환로 86, 101호 (야당동)')).toBe('파주시');
  });

  it('읽을 수 없는 주소는 앞 두 낱말로 물러선다', () => {
    expect(addressArea('어딘가 모를 주소 1')).toBe('어딘가 모를');
  });
});

describe('placeLinks', () => {
  const arcade = {
    name: '어뮤즈타운',
    address: '서울특별시 동작구 만양로14가길 26 어뮤즈타운',
    lat: 37.5133,
    lng: 126.9428,
  };

  it('네이버·카카오는 상호 + 지역으로 검색한다', () => {
    const links = placeLinks(arcade);
    const query = encodeURIComponent('어뮤즈타운 서울 동작구');
    expect(links.naver).toBe(`https://map.naver.com/p/search/${query}`);
    expect(links.kakao).toBe(`https://map.kakao.com/link/search/${query}`);
  });

  it('길찾기는 좌표를 목적지로 연다', () => {
    expect(placeLinks(arcade).directions).toBe(
      `https://map.kakao.com/link/to/${encodeURIComponent('어뮤즈타운')},37.5133,126.9428`,
    );
  });

  it('목적지 이름의 쉼표는 공백으로 — 카카오는 쉼표로 이름·위도·경도를 가른다', () => {
    const url = placeLinks({ ...arcade, name: 'A,B 오락실' }).directions;
    expect(url).toBe(
      `https://map.kakao.com/link/to/${encodeURIComponent('A B 오락실')},37.5133,126.9428`,
    );
  });
});
