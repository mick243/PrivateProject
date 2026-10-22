import { describe, expect, it } from 'vitest';
import { formatOutcome } from '@/lib/chat-outcome';
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
