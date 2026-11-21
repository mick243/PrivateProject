/**
 * 도우미 자유 질문이 실패했을 때 **원인별로** 할 말과 할 일 (2026-11-20 UX 시험 B-4).
 *
 * 예전에는 원인과 상관없이 '답을 만들지 못했어요. 조금 뒤에 다시 시도해 주세요' 한 줄이라,
 * 한도를 다 썼는데 기다리거나, 연결이 끊겼는데 질문을 고치는 일이 생겼습니다.
 * 화면(components/ChatBot.tsx)이 이 결과로 문구 · '다시 보내기' · 로그인 링크를 정합니다.
 *
 * 순수 함수만 둡니다 — 클라이언트 번들에 들어갑니다.
 */

export type ChatFailureCause =
  | 'network'
  | 'login'
  | 'limit'
  | 'unavailable'
  | 'input'
  | 'timeout'
  | 'unclear'
  | 'server';

export interface ChatFailure {
  cause: ChatFailureCause;
  text: string;
  /** 같은 문장을 다시 보내면 될 수 있는지 — '다시 보내기' 단추 */
  retry: boolean;
}

export const UNCLEAR_TEXT =
  "질문을 알아듣지 못했어요. '홍대 사볼'이나 '펌프 최신 버전 수록곡'처럼 적어 주세요";

const DEFAULTS: Record<ChatFailureCause, string> = {
  network: '연결이 잠깐 끊겼어요. 인터넷 연결을 확인하고 다시 보내 주세요',
  login: "로그인하면 자유 질문에 답해 드려요. 오락실은 '홍대 사볼'처럼 적으면 지금 바로 찾아 드려요",
  limit: '오늘 질문을 다 썼어요. 내일 다시 열려요',
  unavailable: '지금은 도우미가 답할 수 없어요. 조금 뒤에 다시 보내 주세요',
  input: '질문을 읽지 못했어요. 조금 줄여서 다시 보내 주세요',
  timeout: '답이 너무 오래 걸렸어요. 다시 보내 주세요',
  unclear: UNCLEAR_TEXT,
  server: '잠깐 문제가 생겼어요. 조금 뒤에 다시 보내 주세요',
};

function causeOf(status: number): ChatFailureCause {
  if (status === 401) return 'login';
  if (status === 429) return 'limit';
  if (status === 503) return 'unavailable';
  if (status === 504) return 'timeout';
  if (status >= 400 && status < 500) return 'input';
  return 'server';
}

/**
 * @param status 응답 상태 코드. fetch 자체가 실패했으면 'network', 빈 답이면 'unclear'
 * @param serverMessage 서버가 준 문구 (있으면 그쪽이 더 구체적입니다 — 한도의 남은 시간 등)
 */
export function describeChatFailure(
  status: number | 'network' | 'unclear',
  serverMessage?: string | null,
): ChatFailure {
  const cause: ChatFailureCause =
    status === 'network' ? 'network' : status === 'unclear' ? 'unclear' : causeOf(status);
  // 연결 · 알아듣지 못함은 서버 문구가 없거나 더 일반적이라 고정 문구를 씁니다.
  const own = cause === 'network' || cause === 'unclear' || cause === 'login';
  const text = (!own && serverMessage?.trim()) || DEFAULTS[cause];
  // 한도 · 로그인 · 알아듣지 못함은 같은 문장을 다시 보내도 같은 결과입니다.
  const retry = cause !== 'limit' && cause !== 'login' && cause !== 'unclear' && cause !== 'input';
  return { cause, text, retry };
}
