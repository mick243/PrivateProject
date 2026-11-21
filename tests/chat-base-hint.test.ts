import { describe, expect, it } from 'vitest';
import {
  cleanPlaceQuery,
  detectBaseHint,
  isSearchRequest,
  parseSearchText,
} from '@/lib/chat-intent';
import { describeChatFailure, UNCLEAR_TEXT } from '@/lib/chat-failure';
import type { Arcade, Machine } from '@/lib/types';

/**
 * 2026-11-20 UX 시험 B-1 · B-2 · B-3 · B-4 — 일상어를 장소로 읽지 않고, '근처' 는 내 위치로,
 * 지역+게임은 로그인 여부와 상관없이 바로 찾고, 실패는 원인별로 말합니다.
 */

const arcade = (id: number, name: string): Arcade => ({
  id,
  name,
  address: '',
  lat: 37.5,
  lng: 127,
  openTime: null,
  closeTime: null,
  is24h: false,
  phone: null,
  note: null,
  homepage: null,
  machines: [],
  distanceKm: null,
  ratingAvg: null,
  reviewCount: 0,
});

const machine = (id: number, name: string, shortName: string): Machine => ({
  id,
  name,
  shortName,
  category: 'rhythm',
});

const MACHINES = [machine(1, 'Pump It Up', '펌프'), machine(2, 'SOUND VOLTEX', '사볼')];
const ARCADES = [arcade(1, '우리동네오락실'), arcade(2, '즐겨찾기오락실'), arcade(3, '짱오락실 홍대점')];

const parse = (text: string) => parseSearchText(text, MACHINES, ARCADES);

describe('기준 위치 말 (B-2 · B-3)', () => {
  it("'우리 동네' 는 상호 '우리동네오락실' 이 아니라 내 위치다", () => {
    const r = parse('우리 동네 오락실 알려줘');
    expect(r.constraints.arcade).toBeNull();
    expect(r.droppedArcade).toBe('우리동네오락실');
    expect(r.hint).toBe('near');
  });

  it("'내 즐겨찾기' 는 상호 '즐겨찾기오락실' 이 아니라 즐겨찾기 목록이다", () => {
    const r = parse('내 즐겨찾기 오락실 모아 보여줘');
    expect(r.constraints.arcade).toBeNull();
    expect(r.constraints.placeQuery).toBeNull();
    expect(r.hint).toBe('favorites');
  });

  it("'찜한 곳' 도 즐겨찾기지만 '찜질방' 은 아니다", () => {
    expect(detectBaseHint('찜한 오락실')).toBe('favorites');
    expect(detectBaseHint('찜질방 옆 오락실')).not.toBe('favorites');
  });

  it("'아이랑 가기' 는 지역이 아니다", () => {
    const r = parse('아이랑 가기 좋은 오락실');
    expect(r.constraints.placeQuery).toBeNull();
  });

  it('근처 · 내 주변 · 여기는 내 위치다', () => {
    for (const text of ['근처 펌프 있는 곳', '내 주변 펌프', '여기 사볼 있는 데']) {
      const r = parse(text);
      expect(r.hint, text).toBe('near');
      expect(r.constraints.placeQuery, text).toBeNull();
      expect(r.constraints.machineIds, text).toHaveLength(1);
    }
  });

  it("지역을 적었으면 그쪽이 기준이다 — '홍대 근처' 는 홍대", () => {
    const r = parse('홍대 근처 사볼');
    expect(r.constraints.placeQuery).toBe('홍대');
    expect(r.hint).toBeNull();
  });

  it('상호를 짚었으면 일상어와 겹치지 않는 한 그대로 둔다', () => {
    const r = parse('짱오락실 홍대점 근처 펌프');
    expect(r.constraints.arcade?.name).toBe('짱오락실 홍대점');
    expect(r.hint).toBeNull();
  });

  it('cleanPlaceQuery 는 일상어만 걷어 내고 지명은 남긴다', () => {
    expect(cleanPlaceQuery('친구랑 강남')).toBe('강남');
    expect(cleanPlaceQuery('중랑')).toBe('중랑');
    expect(cleanPlaceQuery('즐겨찾기 모아')).toBeNull();
    expect(cleanPlaceQuery(null)).toBeNull();
  });
});

describe('isSearchRequest — 로그인 여부로 갈리지 않는다 (B-1 · B-3)', () => {
  it('지역+게임 · 근처+게임 · 게임만은 로그인해도 바로 찾는다', () => {
    for (const text of ['홍대 사볼', '근처 펌프 있는 곳', '내 주변 펌프', '펌프', '우리 동네 오락실 알려줘']) {
      expect(isSearchRequest(text, parse(text), true), text).toBe(true);
      expect(isSearchRequest(text, parse(text), false), text).toBe(true);
    }
  });

  it('상태 · 곡을 묻는 말은 자유 질문이다', () => {
    for (const text of ['홍대 사볼 대기 어때?', '펌프 신곡 뭐 나왔어', '펌프 최신 버전 뭐야?']) {
      expect(isSearchRequest(text, parse(text), true), text).toBe(false);
      expect(isSearchRequest(text, parse(text), false), text).toBe(false);
    }
  });

  it('즐겨찾기는 찾기가 아니라 목록이다', () => {
    const text = '내 즐겨찾기 오락실 모아 보여줘';
    expect(isSearchRequest(text, parse(text), true)).toBe(false);
  });

  it('사전이 없는 화면에서도 오락실 찾기 말은 알아본다', () => {
    expect(isSearchRequest('오락실 찾아줘', null, true)).toBe(true);
  });
});

describe('describeChatFailure — 원인별 문구 (B-4)', () => {
  it('연결이 끊기면 다시 보낼 수 있다', () => {
    const f = describeChatFailure('network');
    expect(f.cause).toBe('network');
    expect(f.retry).toBe(true);
    expect(f.text).toContain('연결');
  });

  it('한도는 서버 문구(남은 시간)를 쓰고 다시 보내기를 주지 않는다', () => {
    const f = describeChatFailure(429, '오늘 챗봇 질문 40번을 다 썼어요. 3시간 뒤에 다시 열려요.');
    expect(f.cause).toBe('limit');
    expect(f.retry).toBe(false);
    expect(f.text).toContain('3시간');
  });

  it('로그인이 필요하면 예시와 함께 안내한다', () => {
    const f = describeChatFailure(401, 'x');
    expect(f.cause).toBe('login');
    expect(f.retry).toBe(false);
    expect(f.text).toContain('홍대 사볼');
  });

  it('빈 답은 알아듣지 못했다고 예시를 준다', () => {
    const f = describeChatFailure('unclear');
    expect(f.text).toBe(UNCLEAR_TEXT);
    expect(f.retry).toBe(false);
  });

  it('서버 오류는 다시 보낼 수 있고, 문구가 없으면 기본 문구', () => {
    const f = describeChatFailure(500);
    expect(f.cause).toBe('server');
    expect(f.retry).toBe(true);
    expect(f.text).toContain('잠깐 문제가 생겼어요');
  });

  it("'실패' · '잘못된' 같은 말을 쓰지 않는다 (DESIGN-GUIDE §8)", () => {
    for (const s of [401, 429, 400, 500, 503, 504, 'network', 'unclear'] as const) {
      const { text } = describeChatFailure(s);
      expect(text).not.toMatch(/실패|잘못된|올바르지 않/);
    }
  });
});
