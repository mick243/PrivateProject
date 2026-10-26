/**
 * 챗봇의 공용 타입과 **의도 판별** 규칙.
 *
 * 서버 모듈(lib/chat-tools.ts)은 getPrismaClient → pg 를 끌고 오므로 클라이언트에서
 * import 할 수 없습니다. 화면과 API 가 같은 말을 쓰도록 순수 값만 모읍니다
 * (lib/community-types.ts 와 같은 규칙).
 */

import type { ChatConstraints } from './query-constraints';
import type { FactorKey, PriorityOrder } from './recommend';

// ─── 대화 ────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant';

/** 웹 검색으로 실제로 읽은 문서 — 답변 아래에 그대로 답니다 */
export interface ChatSource {
  title: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /**
   * 이 말풍선에 붙는 입력 폼.
   *
   * 'priority' 는 1·2·3순위 드롭다운입니다. 폼을 **메시지에 붙이는** 이유:
   * 대화가 길어져도 "그때 뭘 골랐는지" 가 그 자리에 남아야 하고, 새 탐색을
   * 시작하면 이전 폼은 잠긴 채로 기록으로 남습니다.
   */
  form?: 'priority';
  /** 폼이 이미 제출되어 잠겼는지 */
  formDone?: boolean;
  /**
   * 파인더로 데려가는 링크를 붙입니다 — 값은 사용자가 적었던 문장입니다.
   *
   * 챗봇은 모든 화면에 떠 있지만 오락실 탐색은 파인더 화면에서만 됩니다
   * (components/ChatBotHost.tsx). 다른 화면에서 "오락실 찾아줘" 가 오면 폼을
   * 띄웠다가 못 한다고 하는 대신 여기로 보냅니다. 적은 문장을 링크에 실어
   * 파인더에서 다시 적지 않게 합니다.
   */
  goFinder?: string;
  /**
   * 트리거 문장에서 뽑은 제약 (lib/query-constraints.ts).
   *
   * 폼 메시지에 붙여 두는 이유: 제약은 "그 문장"의 것입니다. 새 탐색 문장이
   * 오면 새 폼이 새 제약을 갖고, 이전 폼은 이전 제약과 함께 기록으로 남습니다.
   */
  constraints?: ChatConstraints;
  /** 언급된 오락실 제약을 사용자가 껐는지 — 추출은 오인식일 수 있습니다 */
  constraintOff?: boolean;
  /**
   * 이 말풍선이 알린 탐색 — 아래에 '순서 바꾸기' 와(결과가 조건 탓에 0곳이면)
   * '조건 풀고 다시 찾기' 단추를 붙입니다. 같은 문장의 제약으로 다시 찾습니다.
   */
  followUp?: {
    order: PriorityOrder;
    constraints: ChatConstraints | null;
    /** 반경·기종 필터를 풀면 결과가 생길 수 있는지 (lib/chat-outcome.ts canRetryWithoutConditions) */
    canClear: boolean;
  };
  sources?: ChatSource[];
  /** 답을 기다리는 중 (…) */
  pending?: boolean;
  /** 실패한 답변 — 다시 보내기를 붙입니다 */
  failed?: boolean;
}

/** 서버로 보내는 대화 기록 한 줄 (폼·상태는 서버가 알 필요 없습니다) */
export interface ChatTurn {
  role: ChatRole;
  text: string;
}

export interface ChatResponse {
  text: string;
  sources?: ChatSource[];
}

// ─── 의도 판별 ───────────────────────────────────────────────

/**
 * "오락실 찾아 줘" 인가?
 *
 * **모델에 맡기지 않고 여기서 판별합니다.** 이 갈림길 하나로 대화의 다음
 * 화면이 정해지는데(드롭다운이 뜨느냐 마느냐), 같은 문장에 매번 다른 판단이
 * 나오면 사용자는 무엇을 해야 폼이 뜨는지 배울 수가 없습니다. 그리고 이쪽
 * 경로는 API 키 없이도 끝까지 굴러가야 합니다 — 탐색이 이 앱의 본체입니다.
 *
 * 장소를 가리키는 말과 행동을 가리키는 말이 **둘 다** 있어야 합니다.
 * '오락실' 만으로 걸면 "홍대 오락실 대기 어때?" 같은 질문까지 폼으로 끌려가고,
 * '찾아줘' 만으로 걸면 "이 곡 채보 찾아줘" 가 걸립니다.
 *
 * '근처 · 주변 · 부근 · 인근' 도 행동 말로 칩니다 (2026-10-26 베타 QA). "홍대 근처에 사볼
 * 있는 오락실" 은 누가 봐도 찾아 달라는 말인데 '찾아줘' 가 없다는 이유로 자유 질문으로
 * 넘어가, 로그인하지 않은 사람은 "로그인한 뒤에" 라는 거절을 받았습니다.
 */
const PLACE_WORDS = ['오락실', '아케이드', '게임센터', '게임장'];
const ACTION_WORDS = [
  '찾', '추천', '탐색', '골라', '어디', '갈만', '갈 만', '가까운', '알려',
  '근처', '주변', '부근', '인근',
];

/** 장소·행동을 따지지 않고 바로 폼을 여는 말 */
const DIRECT_WORDS = ['우선순위', '다시 탐색', '재탐색'];

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function isArcadeSearchIntent(text: string): boolean {
  const t = squash(text);
  if (t === '') return false;
  if (isReorderRequest(t)) return true;
  return (
    PLACE_WORDS.some((w) => t.includes(w)) && ACTION_WORDS.some((w) => t.includes(w))
  );
}

/**
 * 순서(1·2·3순위)를 직접 고르겠다는 말인가 — 이때만 순위 폼을 띄웁니다.
 *
 * 그 밖의 탐색은 폼 없이 마지막으로 고른 순서(없으면 DEFAULT_ORDER)로 바로 찾고,
 * 결과 아래 '순서 바꾸기' 단추로 폼을 엽니다. 결과를 보기 전에 세 칸을 다 고르게 하면
 * 그중 둘(대기·컨디션)은 아직 제보가 거의 없어 고르는 의미도 없습니다 (2026-10-26 베타 QA).
 */
export function isReorderRequest(text: string): boolean {
  const t = squash(text);
  return DIRECT_WORDS.some((w) => t.includes(w));
}

/** 상태·수량을 묻는 말 — 이게 있으면 "어디 있나" 가 아니라 "어떤가" 를 묻는 문장입니다 */
const QUESTION_WORDS = ['어때', '어떤', '어떻', '몇', '언제', '뭐', '왜', '얼마'];

/**
 * "홍대 사볼" 같은 **지역 + 기종** 문장인가 — 행동 말이 없어도 찾아 달라는 뜻으로 봅니다.
 *
 * 로그인 여부와 상관없이 씁니다. 인사말이 "홍대 사볼 처럼 적으시면 바로 찾아 드려요" 라고
 * 하는데 로그인한 사람만 모델의 긴 답을 받으면 같은 말에 다른 화면이 뜹니다. 다만
 * "홍대 사볼 대기 어때?" 처럼 상태를 묻는 말이 섞이면 모델 몫으로 둡니다 — 제보를 읽고
 * 답하는 건 모델 쪽 도구입니다 (lib/chat-tools.ts).
 */
export function looksLikePlaceSearch(
  text: string,
  constraints: Pick<ChatConstraints, 'machineIds' | 'placeQuery'> | null,
): boolean {
  if (constraints === null || constraints.machineIds.length === 0 || constraints.placeQuery === null) {
    return false;
  }
  const t = squash(text);
  return !QUESTION_WORDS.some((w) => t.includes(w));
}

/**
 * 오락실 이야기인가 — 장소 말이 있거나, 문장에서 기종·오락실을 알아봤는지.
 *
 * **로그인하지 않은 사람에게만** 쓰는 넓은 그물입니다. 그 사람은 자유 질문을 할 수
 * 없으므로, "홍대 사볼" 처럼 행동 말이 없는 문장을 거절하느니 탐색으로 받는 편이
 * 낫습니다. 로그인한 사람의 같은 문장은 모델이 오락실 도구로 답합니다 (lib/chat-tools.ts).
 */
export function mentionsArcadeTopic(
  text: string,
  constraints: Pick<ChatConstraints, 'arcade' | 'machineIds'> | null,
): boolean {
  const t = squash(text);
  if (t === '') return false;
  if (PLACE_WORDS.some((w) => t.includes(w))) return true;
  return constraints !== null && (constraints.arcade !== null || constraints.machineIds.length > 0);
}

// ─── 우선순위 폼 ─────────────────────────────────────────────

/** 드롭다운 세 칸의 라벨. 순위 번호는 화면이 붙입니다 */
export const RANK_LABELS = ['1순위', '2순위', '3순위'] as const;

/**
 * 탐색 결과 — 챗봇이 "완료" 라고 말할 때 함께 넘기는 요약.
 * 지도·목록은 부모(ArcadeFinder)가 이미 같은 데이터를 들고 있으므로
 * 여기서는 **말로 할 몫**만 담습니다.
 */
export interface SearchOutcome {
  /** 반경 안에서 실제로 순위를 매긴 곳의 수 */
  total: number;
  /** 0 = 반경 전체 (기준점은 있지만 자르지 않음) */
  radiusKm: number;
  /** 기준점이 없으면 거리 항목이 빠진 채로 매겨졌다는 뜻 */
  hasOrigin: boolean;
  top: {
    name: string;
    score: number;
    distanceLabel: string | null;
    reason: string;
    /** 근거 없이 가운데 값으로 들어간 항목 이름 (lib/recommend.ts missingFactors) */
    missing: string[];
  }[];
  /** 사용자가 기종 필터를 걸어 둔 경우 그 이름들 */
  machineNames: string[];
  /**
   * 그 기종을 보유로 등록한 오락실이 **전국에 한 곳도 없는지**.
   *
   * 결과 0곳의 이유가 반경인지 데이터인지에 따라 할 말이 다릅니다 — 반경이면 "넓혀
   * 보세요" 가 답이지만, 아무도 등록하지 않은 기종이면 넓혀도 0곳입니다. 전체 목록을
   * 아직 모르면(첫 조회가 걸러진 조회였으면) false 로 두고 일반 문구로 물러섭니다.
   */
  machineUnregistered: boolean;
  /**
   * 기준점으로 삼고 결과에서 뺀 오락실 이름 (문장에 언급된 "지금 있는 곳").
   * 없으면 null. 말풍선이 이 사실을 밝혀야 "왜 그곳이 목록에 없지" 가 안 생깁니다.
   */
  excluded: string | null;
  /** 문장에 적힌 지역을 기준점으로 썼으면 그 이름 ('홍대입구역'). 없으면 null */
  placeName: string | null;
  /**
   * 탐색 순간 목록 조회가 아직 진행 중이었는지.
   *
   * 말풍선은 그때의 스냅샷이지만 목록·지도는 응답이 오면 다시 그려집니다.
   * 이 값이 true 면 "12곳" 이라고 말해 놓고 목록이 15곳이 되는 일이 생기므로,
   * 그럴 수 있다고 미리 적습니다.
   */
  stale: boolean;
}

export type { FactorKey };
