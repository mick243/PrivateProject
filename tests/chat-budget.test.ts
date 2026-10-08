import { describe, expect, it } from 'vitest';
import { addUsage, emptyUsage, HISTORY_CHAR_BUDGET, trimTurns, type Turn } from '@/lib/chat-budget';

/**
 * 챗봇 한 요청의 분량 상한 (lib/chat-budget.ts).
 *
 * 2026-09-28 측정: 대화 24턴 × 4,000자에 도구를 끝까지 부르면 질문 하나에 모델로 858,396자가
 * 나갔습니다 — 왕복마다 대화 전체를 다시 싣기 때문입니다. 여기서는 "무엇을 남기고 무엇을 빼는가"
 * 를 못 박습니다. 빼는 규칙이 틀리면 에러가 아니라 **엉뚱한 답**이 나옵니다.
 */

const t = (role: Turn['role'], n: number, ch = '가'): Turn => ({ role, text: ch.repeat(n) });

describe('trimTurns — 최근 대화부터 상한까지', () => {
  it('상한 안이면 그대로 둔다', () => {
    const turns = [t('user', 10), t('assistant', 10), t('user', 10)];
    expect(trimTurns(turns)).toEqual({ turns, dropped: 0 });
  });

  it('넘치면 앞쪽부터 빼고, 뺀 수를 첫 턴 앞에 알린다', () => {
    // 사용자 말로 끝나는 23턴 × 4,000자 (입력 검증이 허용하는 모양)
    const turns = Array.from({ length: 23 }, (_, i) => t(i % 2 === 0 ? 'user' : 'assistant', 4000));
    turns[22] = t('user', 4000, '나');
    const { turns: kept, dropped } = trimTurns(turns);
    expect(kept.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET + 40);
    expect(kept.at(-1)!.text).toBe('나'.repeat(4000)); // 답해야 할 질문은 늘 남는다
    expect(kept[0]!.role).toBe('user'); // 조수 말로 시작하지 않는다
    expect(dropped).toBe(turns.length - kept.length);
    expect(kept[0]!.text.startsWith(`[앞선 대화 ${dropped}개는 길이 제한으로 생략했습니다]`)).toBe(true);
  });

  it('이어진 구간만 남긴다 — 큰 턴을 건너뛰고 더 옛 턴을 끼워 넣지 않는다', () => {
    const turns = [t('user', 5), t('assistant', 5), t('user', 11_000), t('assistant', 3000), t('user', 100)];
    const { turns: kept, dropped } = trimTurns(turns);
    // 11,000 자 턴이 넘쳐 거기서 멈춘다 — 그 앞의 짧은 두 턴을 건너뛰어 붙이지 않는다
    expect(dropped).toBe(3);
    expect(kept.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    // 질문 바로 앞의 조수 말은 남기고, 그 앞에 알림만 담은 사용자 턴을 세운다
    expect(kept[0]!.text).toBe('[앞선 대화 3개는 길이 제한으로 생략했습니다]');
    expect(kept[1]!.text).toHaveLength(3000);
    expect(kept[2]!.text).toHaveLength(100);
  });

  it('원본 배열을 바꾸지 않는다 — 요청 본문을 로그·재시도에 다시 쓸 수 있게', () => {
    const turns = [t('user', 7000), t('assistant', 7000), t('user', 10)];
    const copy = JSON.parse(JSON.stringify(turns));
    trimTurns(turns);
    expect(turns).toEqual(copy);
  });
});

describe('addUsage — 요청 하나의 토큰을 더한다', () => {
  it('왕복마다 더하고, 없는 칸은 0 으로', () => {
    const u = emptyUsage();
    addUsage(u, { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 });
    addUsage(u, { promptTokenCount: 150, thoughtsTokenCount: 5, toolUsePromptTokenCount: 30, totalTokenCount: 185 });
    addUsage(u, undefined);
    expect(u).toEqual({ calls: 3, prompt: 250, output: 20, thoughts: 5, toolUse: 30, total: 305 });
  });
});
