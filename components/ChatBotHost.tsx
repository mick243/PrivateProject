'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import ChatBot from './ChatBot';
import type { SearchOutcome } from '@/lib/chat-types';
import type { ChatConstraints } from '@/lib/query-constraints';
import type { PartialOrder, PriorityOrder } from '@/lib/recommend';

/**
 * 챗봇을 **모든 화면**에 띄우기 위한 자리.
 *
 * ─── 왜 provider 가 필요한가 ───────────────────────────────
 * 챗봇이 하는 일은 둘입니다.
 *   · 자유 질문 → 서버(/api/chat). 어느 화면에서든 됩니다.
 *   · 오락실 탐색 → **파인더의 데이터**가 있어야 합니다. 순위 계산과 지도 표시는
 *     ArcadeFinder 가 하고 챗봇은 말할 몫만 받습니다(ChatBot.tsx Props 주석).
 *
 * 그래서 챗봇을 레이아웃에 두되, 파인더가 떠 있는 동안에만 자기 탐색 기능을
 * 여기 **등록**합니다. 등록이 없으면(= 파인더가 아닌 화면) 챗봇은 탐색을 그 자리에서
 * 하지 않고 파인더로 데려갑니다.
 *
 * 챗봇을 두 번 그리지 않는 것이 핵심입니다 — 레이아웃과 파인더에 하나씩 두면
 * 화면 오른쪽 아래에 단추가 두 개 겹치고, 대화 기록도 둘로 갈립니다.
 */

export interface ChatSearchApi {
  onSearch: (order: PriorityOrder, constraints: ChatConstraints | null) => SearchOutcome;
  extract: (text: string) => ChatConstraints;
  initialOrder: PartialOrder;
}

interface ContextValue {
  api: ChatSearchApi | null;
  register: (api: ChatSearchApi | null) => void;
  suppress: (on: boolean) => void;
}

const ChatSearchContext = createContext<ContextValue | null>(null);

/**
 * 파인더가 자기 탐색 기능을 등록합니다. 언마운트하면 스스로 지웁니다 — 남겨 두면
 * 다른 화면에서 챗봇이 이미 사라진 지도를 조작하려 듭니다.
 *
 * `api` 는 매 렌더 새로 만들어지는 객체라 의존성에 그대로 넣으면 등록이 무한히
 * 반복됩니다. 부르는 쪽에서 useMemo 로 묶어 넘기세요 (ArcadeFinder 참고).
 */
export function useRegisterChatSearch(api: ChatSearchApi): void {
  const ctx = useContext(ChatSearchContext);
  const register = ctx?.register;
  useEffect(() => {
    if (!register) return;
    register(api);
    return () => register(null);
  }, [register, api]);
}

/**
 * 이 화면이 떠 있는 동안 챗봇을 감춥니다.
 *
 * 전역으로 올리기 전에는 오락실 등록·수정 중에만 챗봇을 안 그렸습니다 —
 * 단추가 폼 위에 겹쳐 앉기 때문입니다. 레이아웃으로 옮기면서 그 조건이 사라지므로
 * 같은 일을 할 손잡이를 남겨 둡니다. 겹쳐 부르는 화면이 생겨도 되도록 수를 셉니다.
 */
export function useSuppressChatBot(active: boolean): void {
  const suppress = useContext(ChatSearchContext)?.suppress;
  useEffect(() => {
    if (!suppress || !active) return;
    suppress(true);
    return () => suppress(false);
  }, [suppress, active]);
}

/** 챗봇이 읽는 쪽. 등록이 없으면 null — 탐색을 할 수 없는 화면이라는 뜻입니다. */
export function useChatSearch(): ChatSearchApi | null {
  return useContext(ChatSearchContext)?.api ?? null;
}

export default function ChatBotHost({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<ChatSearchApi | null>(null);
  /** 감추라고 한 화면의 수. 0 보다 크면 그리지 않습니다 (useSuppressChatBot). */
  const [hidden, setHidden] = useState(0);

  /*
    등록 해제가 **늦게 오는** 경우를 막습니다. 파인더를 떠나면 새 화면이 먼저
    마운트되고 파인더의 정리 함수가 나중에 도는 순서가 있는데, 그때 null 을 그대로
    쓰면 방금 등록한 다른 api 를 지워 버립니다. 지금은 파인더 하나뿐이라 실제로
    겹치지 않지만, 두 번째 등록자가 생기면 조용히 깨질 자리라 미리 막아 둡니다.
  */
  const register = useCallback((next: ChatSearchApi | null) => {
    setApi((prev) => (next === null && prev === null ? prev : next));
  }, []);

  const suppress = useCallback((on: boolean) => {
    setHidden((n) => Math.max(0, n + (on ? 1 : -1)));
  }, []);

  const value = useMemo(() => ({ api, register, suppress }), [api, register, suppress]);

  return (
    <ChatSearchContext.Provider value={value}>
      {children}
      {hidden === 0 && <ChatBot />}
    </ChatSearchContext.Provider>
  );
}
