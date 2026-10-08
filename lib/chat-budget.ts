/**
 * 챗봇 한 요청이 모델에 보내는 분량의 상한 — **토큰 사용량을 코드로 묶는 자리**.
 *
 * 2026-09-28 목표 규모 DB 에서 라우트를 그대로 돌려 모델로 나가는 요청을 쟀습니다(모델은 대역).
 * 대화 24턴 × 4,000자(입력 검증의 최대치)에 도구를 끝까지 부르는 경우, 질문 **하나**에 모델을
 * 8번 부르면서 모두 합쳐 **858,396자**를 보냈습니다. 매 왕복마다 대화 전체(96,000자)를 다시 싣기
 * 때문입니다 — 도구 결과 자체는 한 번에 2,000자 안팎이었습니다. 비용은 입력 토큰에 비례하므로,
 * 가장 효과가 큰 손잡이는 "대화를 얼마나 거슬러 올라가 싣나" 와 "도구를 몇 번 받아 주나" 입니다.
 *
 * 순수 함수만 둡니다 — 라우트(app/api/chat/route.ts)가 쓰고, 테스트가 모델 없이 돕니다.
 */

/** 한 요청에 싣는 대화 기록의 글자 상한 (최근 것부터). 입력 검증의 한 턴 최대(4,000자)의 세 배 */
export const HISTORY_CHAR_BUDGET = 12_000;

/**
 * 한 요청 안에서 도구 결과를 모델에 돌려주는 누적 글자 상한. 넘으면 **다음 왕복에서 함수 호출을
 * 막아** 찾은 데까지로 답하게 합니다 — 쪽 넘기기(lib/chat-tools.ts)가 생긴 뒤로는 모델이 한 쪽씩
 * 계속 넘길 수 있어서, 왕복 상한(8)만으로는 도구 결과가 쌓이는 양을 묶지 못합니다.
 * 한 쪽(5건)이 대략 1,000~1,500자라 열 쪽 남짓입니다.
 */
export const TOOL_OUTPUT_CHAR_BUDGET = 12_000;

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface TrimmedTurns {
  turns: Turn[];
  /** 상한 때문에 빼낸 앞쪽 턴 수 */
  dropped: number;
}

/**
 * 최근 대화부터 거꾸로 채워 상한 안에 둡니다.
 *
 * - **마지막 사용자 말은 늘 남깁니다** — 답해야 할 질문입니다(한 턴은 입력 검증이 4,000자로 막습니다).
 * - 이어진 구간만 남깁니다. 중간을 건너뛰고 더 옛 턴을 끼워 넣으면 대화가 앞뒤가 안 맞습니다.
 * - 뺀 것이 있으면 맨 앞에서 한 줄로 알립니다. 모델이 "앞에서 말한 그 오락실" 을 못 찾을 때
 *   지어내지 말고 되묻게 하려는 것입니다. 남은 구간이 조수 말로 시작하면 그 앞에 알림만 담은
 *   사용자 턴을 세웁니다 — 대화는 사용자 말로 시작해야 하고, 질문 바로 앞의 조수 말은 질문을
 *   읽는 데 가장 필요한 맥락이라 빼지 않습니다.
 */
export function trimTurns(turns: readonly Turn[], budget = HISTORY_CHAR_BUDGET): TrimmedTurns {
  if (turns.length === 0) return { turns: [], dropped: 0 };

  let used = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = turns[i]!.text.length;
    const isLast = i === turns.length - 1;
    if (!isLast && used + len > budget) break;
    used += len;
    start = i;
  }

  const kept = turns.slice(start).map((t) => ({ ...t }));
  const dropped = start;
  if (dropped > 0) {
    const note = `[앞선 대화 ${dropped}개는 길이 제한으로 생략했습니다]`;
    if (kept[0]!.role === 'assistant') kept.unshift({ role: 'user', text: note });
    else kept[0] = { ...kept[0]!, text: `${note}\n${kept[0]!.text}` };
  }
  return { turns: kept, dropped };
}

/** 모델 응답의 usageMetadata 를 요청 하나 단위로 더합니다 (운영 로그용) */
export interface TokenUsage {
  calls: number;
  prompt: number;
  output: number;
  thoughts: number;
  toolUse: number;
  total: number;
}

export function emptyUsage(): TokenUsage {
  return { calls: 0, prompt: 0, output: 0, thoughts: 0, toolUse: 0, total: 0 };
}

export function addUsage(
  into: TokenUsage,
  meta:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        toolUsePromptTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined,
): TokenUsage {
  into.calls += 1;
  into.prompt += meta?.promptTokenCount ?? 0;
  into.output += meta?.candidatesTokenCount ?? 0;
  into.thoughts += meta?.thoughtsTokenCount ?? 0;
  into.toolUse += meta?.toolUsePromptTokenCount ?? 0;
  into.total += meta?.totalTokenCount ?? 0;
  return into;
}
