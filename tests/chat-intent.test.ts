import { describe, expect, it } from 'vitest';
import {
  isArcadeSearchIntent,
  isReorderRequest,
  looksLikePlaceSearch,
  mentionsArcadeTopic,
} from '@/lib/chat-types';

/**
 * 이 판별이 대화의 다음 화면을 정합니다 — 걸리면 우선순위 드롭다운이 뜨고,
 * 안 걸리면 모델에게 질문이 넘어갑니다. 그래서 규칙을 못 박아 둡니다.
 */
describe('isArcadeSearchIntent', () => {
  it('장소 + 행동이 함께 있으면 탐색이다', () => {
    for (const text of [
      '내 주변 오락실 찾아줘',
      '오락실 추천해줘',
      '가까운 게임센터 알려줘',
      '아케이드 어디 갈까',
      '갈만한 오락실 있어?',
      '오락실 탐색',
    ]) {
      expect(isArcadeSearchIntent(text), text).toBe(true);
    }
  });

  it('장소만 있는 질문은 탐색이 아니다 — 그냥 물어본 것이다', () => {
    for (const text of ['홍대 오락실 대기 어때?', '이 오락실 펌프 몇 대야?', '오락실 많네']) {
      expect(isArcadeSearchIntent(text), text).toBe(false);
    }
  });

  it('"오락실 영업시간 알려줘" 는 탐색으로 샌다 — 알면서 그대로 둔 쪽이다', () => {
    // '알려' 를 행동 목록에서 빼면 이 문장은 안 걸리지만 "오락실 알려줘"
    // 라는 진짜 탐색 요청도 함께 놓칩니다. 폼이 잘못 떠도 무시하고 다시
    // 물으면 되지만, 놓치면 탐색을 시작할 방법이 없어집니다.
    expect(isArcadeSearchIntent('오락실 영업시간 알려줘')).toBe(true);
  });

  it('행동만 있는 질문은 탐색이 아니다', () => {
    for (const text of [
      '이 곡 채보 찾아줘',
      '펌프 신곡 추천해줘',
      '사볼 공략 알려줘',
    ]) {
      expect(isArcadeSearchIntent(text), text).toBe(false);
    }
  });

  it('우선순위·재탐색은 장소 말 없이도 바로 폼을 연다', () => {
    expect(isArcadeSearchIntent('우선순위 바꿀래')).toBe(true);
    expect(isArcadeSearchIntent('다시 탐색해줘')).toBe(true);
  });

  it('빈 입력과 공백은 탐색이 아니다', () => {
    expect(isArcadeSearchIntent('')).toBe(false);
    expect(isArcadeSearchIntent('   ')).toBe(false);
  });

  it('띄어쓰기가 달라도 같게 본다', () => {
    expect(isArcadeSearchIntent('갈  만한   오락실')).toBe(true);
  });

  it('근처·주변도 찾아 달라는 말이다 — 2026-10-26 베타 QA 에서 거절당한 문장', () => {
    for (const text of ['홍대 근처에 사볼 있는 오락실', '강남역 주변 오락실', '신촌 부근 게임센터']) {
      expect(isArcadeSearchIntent(text), text).toBe(true);
    }
  });
});

describe('isReorderRequest — 순위 폼은 직접 고르겠다고 할 때만', () => {
  it('우선순위·재탐색이면 폼을 띄운다', () => {
    expect(isReorderRequest('우선순위 바꿀래')).toBe(true);
    expect(isReorderRequest('다시 탐색해줘')).toBe(true);
  });

  it('보통 탐색 문장은 폼 없이 바로 찾는다', () => {
    expect(isReorderRequest('오락실 찾아줘')).toBe(false);
    expect(isReorderRequest('홍대 근처에 사볼 있는 오락실')).toBe(false);
  });
});

describe('looksLikePlaceSearch — "홍대 사볼"', () => {
  it('지역과 기종이 있으면 행동 말이 없어도 탐색이다', () => {
    expect(looksLikePlaceSearch('홍대 사볼', { machineIds: [2], placeQuery: '홍대' })).toBe(true);
  });

  it('상태를 묻는 말이 섞이면 모델 몫이다', () => {
    for (const text of ['홍대 사볼 대기 어때?', '강남 펌프 몇 대 있어?']) {
      expect(looksLikePlaceSearch(text, { machineIds: [1], placeQuery: '홍대' }), text).toBe(false);
    }
  });

  it('지역이나 기종이 빠지면 아니다', () => {
    expect(looksLikePlaceSearch('홍대', { machineIds: [], placeQuery: '홍대' })).toBe(false);
    expect(looksLikePlaceSearch('사볼', { machineIds: [2], placeQuery: null })).toBe(false);
    expect(looksLikePlaceSearch('홍대 사볼', null)).toBe(false);
  });
});

describe('mentionsArcadeTopic — 로그인하지 않은 사람의 넓은 그물', () => {
  const none = { arcade: null, machineIds: [] };

  it('장소 말이나 알아본 기종·오락실이 있으면 오락실 이야기다', () => {
    expect(mentionsArcadeTopic('홍대 오락실 대기 어때?', none)).toBe(true);
    expect(mentionsArcadeTopic('홍대 사볼', { arcade: null, machineIds: [2] })).toBe(true);
    expect(
      mentionsArcadeTopic('짱오락실 어때', { arcade: { id: 1, name: '짱오락실', lat: 0, lng: 0 }, machineIds: [] }),
    ).toBe(true);
  });

  it('둘 다 없으면 자유 질문이다', () => {
    expect(mentionsArcadeTopic('오늘 날씨 어때', none)).toBe(false);
    expect(mentionsArcadeTopic('', none)).toBe(false);
  });

  it('파인더 밖이라 사전이 없으면(null) 장소 말로만 가른다', () => {
    expect(mentionsArcadeTopic('강남 게임센터', null)).toBe(true);
    expect(mentionsArcadeTopic('홍대 사볼', null)).toBe(false);
  });
});
