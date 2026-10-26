import { describe, expect, it } from 'vitest';
import { canRetryWithoutConditions, formatOutcome } from '@/lib/chat-outcome';
import type { SearchOutcome } from '@/lib/chat-types';
import { describeScoring, type PriorityOrder } from '@/lib/recommend';

/**
 * 챗봇 탐색 결과 말풍선. 2026-10-22 첫 사용자 점검에서 둘이 틀렸다 —
 * "노량진 근처에 사볼 있는 오락실" 의 사볼이 말없이 빠졌고, "75점" 이 무슨 뜻인지
 * 말하지 않았다. 여기 못 박는 것: 기종이 등록된 곳이 아예 없으면 그렇다고 말하고,
 * 점수에는 그 뜻과 비어 있던 항목을 붙인다.
 */

const ORDER: PriorityOrder = ['distance', 'wait', 'condition'];

const outcome = (over: Partial<SearchOutcome> = {}): SearchOutcome => ({
  total: 3,
  radiusKm: 0,
  hasOrigin: true,
  top: [
    {
      name: '어뮤즈타운',
      score: 75,
      distanceLabel: '0m',
      reason: '가까워서',
      missing: ['대기 인원', '기체 컨디션'],
    },
  ],
  machineNames: [],
  machineUnregistered: false,
  excluded: null,
  placeName: null,
  stale: false,
  ...over,
});

describe('formatOutcome — 기종 조건', () => {
  it('그 기종을 등록한 곳이 전국에 없으면 기종 이름을 들어 그렇게 말한다', () => {
    const text = formatOutcome(
      outcome({ total: 0, top: [], machineNames: ['사볼'], machineUnregistered: true }),
      ORDER,
    );
    expect(text).toContain('사볼 보유로 등록된 오락실이 아직 없습니다');
    // 반경 탓이 아니므로 "반경을 넓혀라" 는 답이 아니다
    expect(text).not.toContain('반경');
    // 다음 행동 — 제보 경로와 기종 없이 찾는 법
    expect(text).toContain('기종 선택 → 제보');
    expect(text).toContain('오락실 찾아줘');
  });

  it('근처에만 없을 때는 예전처럼 반경·필터를 풀라고 한다', () => {
    const text = formatOutcome(
      outcome({ total: 0, top: [], radiusKm: 2, machineNames: ['사볼'], machineUnregistered: false }),
      ORDER,
    );
    expect(text).toContain('반경 2km 안에 조건에 맞는 오락실이 없습니다');
  });

  it('기종으로 좁혀 찾았으면 무슨 기종으로 좁혔는지 적는다', () => {
    const text = formatOutcome(outcome({ machineNames: ['펌프'] }), ORDER);
    expect(text).toContain('(펌프 보유)');
  });
});

/**
 * 2026-10-26 베타 QA — 목록에서 켜 둔 사볼 칩과 반경 5km 가 남아 0곳이 됐는데, 말풍선은
 * "반경을 넓히거나 기종 필터를 풀어 보세요" 뿐이라 무엇이 걸렸는지 알 수 없었다.
 */
describe('formatOutcome — 0곳일 때 걸린 조건', () => {
  const zero = outcome({ total: 0, top: [], radiusKm: 5, machineNames: ['사볼'] });

  it('걸린 조건을 이름으로 적는다', () => {
    expect(formatOutcome(zero, ORDER)).toContain('걸린 조건 · 사볼 · 반경 5km');
  });

  it('풀 수 있으면 단추를 가리키고, 아니면 예전처럼 직접 풀라고 한다', () => {
    expect(formatOutcome(zero, ORDER, { canClear: true })).toContain("'조건 풀고 다시 찾기'");
    expect(formatOutcome(zero, ORDER)).toContain('반경을 넓히거나 기종 필터를 풀어 보세요');
  });

  it('기준점이 없으면 반경은 조건이 아니다 (자르지 않는다)', () => {
    const text = formatOutcome(outcome({ total: 0, top: [], radiusKm: 5, hasOrigin: false, machineNames: ['사볼'] }), ORDER);
    expect(text).toContain('걸린 조건 · 사볼');
    expect(text).not.toContain('반경 5km');
  });
});

describe('canRetryWithoutConditions', () => {
  it('반경이 잘랐으면 풀어 볼 만하다', () => {
    expect(canRetryWithoutConditions(outcome({ total: 0, top: [], radiusKm: 5 }), false)).toBe(true);
  });

  it('목록에서 켜 둔 기종 칩이 걸렸으면 풀어 볼 만하다', () => {
    expect(canRetryWithoutConditions(outcome({ total: 0, top: [], machineNames: ['사볼'] }), false)).toBe(true);
  });

  it('기종이 문장에서 왔고 반경이 없으면 풀어도 같다 — 다시 찾을 때도 문장의 기종은 남는다', () => {
    expect(canRetryWithoutConditions(outcome({ total: 0, top: [], machineNames: ['사볼'] }), true)).toBe(false);
  });

  it('결과가 있거나, 그 기종을 등록한 곳이 전국에 없으면 단추를 달지 않는다', () => {
    expect(canRetryWithoutConditions(outcome({ radiusKm: 5 }), false)).toBe(false);
    expect(
      canRetryWithoutConditions(
        outcome({ total: 0, top: [], radiusKm: 5, machineNames: ['사볼'], machineUnregistered: true }),
        false,
      ),
    ).toBe(false);
  });
});

describe('formatOutcome — 문장의 지역', () => {
  it('지역을 기준점으로 썼으면 그 이름을 적는다', () => {
    const text = formatOutcome(outcome({ placeName: '홍대입구역' }), ORDER);
    expect(text).toContain("'홍대입구역'에서 가까운 순으로 3곳");
  });
});

describe('formatOutcome — 점수의 뜻', () => {
  it('점수 옆에 근거 없이 들어간 항목을 적는다', () => {
    const text = formatOutcome(outcome(), ORDER);
    expect(text).toContain('1위 어뮤즈타운 — 75점 · 0m (가까워서 · 대기 인원·기체 컨디션 정보 없음)');
  });

  it('비어 있던 항목이 없으면 이유만 적는다', () => {
    const text = formatOutcome(
      outcome({ top: [{ name: 'A', score: 90, distanceLabel: null, reason: '기체 상태가 좋아서', missing: [] }] }),
      ORDER,
    );
    expect(text).toContain('1위 A — 90점 (기체 상태가 좋아서)');
  });

  it('점수가 무엇인지 한 줄로 밝힌다', () => {
    expect(formatOutcome(outcome(), ORDER)).toContain(describeScoring());
  });
});
