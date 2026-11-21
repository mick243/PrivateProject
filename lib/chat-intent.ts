/**
 * 도우미 문장의 **기준 위치 말**을 가려냅니다 — '우리 동네' · '내 근처' · '즐겨찾기'.
 *
 * 2026-11-20 UX 시험(B-2 · B-3)에서 이런 일상어가 지역 이름이나 상호로 읽혔습니다.
 *   · '우리 동네 오락실 알려줘' → 상호 '우리동네오락실'(인천 영흥도)로 옮겨 감
 *   · '내 즐겨찾기 오락실 모아 보여줘' → 상호 '즐겨찾기오락실'을 기준으로 잡음
 *   · '아이랑 가기 좋은 오락실' → '아이랑 가기' 를 지역으로 찾아 엉뚱한 곳으로 감
 *   · '근처 펌프 있는 곳' → 직전에 찾은 홍대를 기준으로 씀
 * 여기서 그 말들을 먼저 걸러, '근처' 류는 **지금 내 위치**로, '즐겨찾기' 류는 **내 즐겨찾기**로
 * 보냅니다. 이름은 extractConstraints(lib/query-constraints.ts)가 뽑고, 이 파일은 그 결과를
 * 다듬기만 합니다 — 파인더 검색창(F-5)도 같은 해석을 쓸 수 있게 순수 함수만 둡니다.
 */

import { extractConstraints, type ChatConstraints } from './query-constraints';
import { isArcadeSearchIntent, looksLikePlaceSearch, mentionsArcadeTopic, QUESTION_WORDS } from './chat-types';
import type { Arcade, Machine } from './types';

/**
 * 문장이 가리키는 기준 위치의 종류.
 * - `near` — 지금 내 위치 (없으면 지도 가운데)
 * - `favorites` — 내 즐겨찾기
 * - `null` — 따로 말하지 않음 (지역 이름이 있으면 그쪽, 없으면 near 와 같게 다룹니다)
 */
export type BaseHint = 'near' | 'favorites' | null;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** '지금 내 위치' 를 뜻하는 말 — 긴 것부터 (상호 대조에 쓰는 말과 같습니다) */
const NEAR_PHRASES = [
  '우리 동네', '우리동네', '내 근처', '내근처', '내 주변', '내주변', '이 근처', '이근처',
  '내 위치', '현재 위치', '현위치', '가까운', '가까이', '근처', '주변', '여기', '동네',
];

/** '내 즐겨찾기' 를 뜻하는 말. '찜' 은 '찜질방' 을 피합니다 */
const FAVORITE_PATTERN = /즐겨\s*찾기|즐찾|찜(?!질)/;

/**
 * 지역 이름 후보에서 버릴 일상어 — findPlaceQuery 가 지역으로 남기는 말들입니다.
 * 지명과 겹치지 않는 것만 넣습니다.
 */
const EVERYDAY_WORDS = new Set([
  '우리', '동네', '우리동네', '즐겨찾기', '즐찾', '찜', '찜한', '모아', '모아서', '전부', '모두',
  '같이', '함께', '가기', '놀기', '놀러', '놀만한', '데이트', '혼자서', '처음', '초보',
]);

/** '○○랑 · ○○하고 · ○○끼리' 의 ○○ — 함께 가는 사람이지 장소가 아닙니다 */
const COMPANIONS = new Set([
  '아이', '아이들', '애', '애들', '가족', '친구', '친구들', '엄마', '아빠', '부모님', '여친', '남친',
  '여자친구', '남자친구', '연인', '동생', '형', '누나', '언니', '오빠', '조카', '아들', '딸', '애인',
]);
const COMPANION_PARTICLES = ['이랑', '랑', '하고', '끼리', '이와', '와', '과'];

/**
 * 앱 밖의 이야기(곡 · 버전 · 대회 …)를 묻는 말. 이게 있으면 게임 이름이 있어도 오락실 찾기가
 * 아니라 자유 질문입니다 ('펌프 신곡').
 */
const TOPIC_WORDS = [
  '신곡', '버전', '채보', '서열', '난이도', '레벨', '대회', '업데이트', '패치', '공략', '수록', '곡',
];

function isEverydayToken(token: string): boolean {
  if (EVERYDAY_WORDS.has(token)) return true;
  // '아이랑' 은 '아이'+'랑' 이지 '아'+'이랑' 이 아니다 — 붙을 수 있는 조사를 모두 대 본다.
  return COMPANION_PARTICLES.some(
    (p) => token.length > p.length && token.endsWith(p) && COMPANIONS.has(token.slice(0, -p.length)),
  );
}

/** 지역 이름 후보에서 일상어를 걷어 냅니다. 남는 게 없으면 null */
export function cleanPlaceQuery(query: string | null): string | null {
  if (!query) return null;
  const kept = query.split(/\s+/).filter((t) => t !== '' && !isEverydayToken(t));
  const joined = kept.join(' ');
  return joined.length >= 2 ? joined : null;
}

/** 문장에 들어 있는 '지금 내 위치' 말 (상호 대조에 씁니다) */
function nearPhrasesIn(text: string): string[] {
  const t = squash(text);
  return NEAR_PHRASES.filter((p) => t.includes(p));
}

export function detectBaseHint(text: string): BaseHint {
  if (FAVORITE_PATTERN.test(text)) return 'favorites';
  return nearPhrasesIn(text).length > 0 ? 'near' : null;
}

export interface RefinedQuery {
  constraints: ChatConstraints;
  hint: BaseHint;
  /** 일상어와 겹쳐 버린 상호 ('우리동네오락실') — 화면이 "그 가게였다면" 을 물을 때 씁니다 */
  droppedArcade: string | null;
}

/**
 * extractConstraints 의 결과에서 일상어로 잘못 잡힌 상호 · 지역을 걷어 냅니다.
 *
 * - 상호가 문장의 '우리 동네' · '즐겨찾기' 같은 말을 품고 있으면 그 상호는 버립니다.
 * - 지역 이름 후보에서 '아이랑' · '가기' · '모아' 같은 일상어를 뺍니다.
 * - 지역 · 상호가 남아 있으면 그쪽이 기준이라 hint 는 null 입니다 ('홍대 근처' 는 홍대).
 *   즐겨찾기는 예외 — 장소가 아니라 목록을 달라는 말입니다.
 */
export function refineConstraints(text: string, c: ChatConstraints): RefinedQuery {
  const hint = detectBaseHint(text);
  let arcade = c.arcade;
  let droppedArcade: string | null = null;

  if (arcade && hint !== null) {
    const name = norm(arcade.name);
    const words = hint === 'favorites' ? ['즐겨찾기', '즐찾', '찜'] : nearPhrasesIn(text).map(norm);
    if (words.some((w) => name.includes(w))) {
      droppedArcade = arcade.name;
      arcade = null;
    }
  }

  const placeQuery = arcade ? null : cleanPlaceQuery(c.placeQuery);
  const constraints: ChatConstraints = { ...c, arcade, placeQuery };
  const explicit = arcade !== null || placeQuery !== null || c.place !== null;
  return {
    constraints,
    hint: hint === 'favorites' ? hint : explicit ? null : hint,
    droppedArcade,
  };
}

/**
 * 문장 하나 → 지역 · 게임 · 기준 위치 말 (파인더 검색창 F-5 와 도우미가 같이 씁니다).
 *
 * @example parseSearchText('홍대 사볼', machines)
 *   → { constraints: { placeQuery: '홍대', machineIds: [사볼 id], … }, hint: null }
 * @example parseSearchText('우리 동네 펌프', machines) → hint: 'near', placeQuery: null
 */
export function parseSearchText(
  text: string,
  machines: Machine[],
  arcades: Arcade[] = [],
): RefinedQuery {
  return refineConstraints(text, extractConstraints(text, arcades, machines));
}

/** 상태 · 앱 밖의 이야기를 묻는 문장인가 ('대기 어때' · '신곡 뭐 나왔어') */
export function asksAboutSomething(text: string): boolean {
  const t = squash(text);
  return QUESTION_WORDS.some((w) => t.includes(w)) || TOPIC_WORDS.some((w) => t.includes(w));
}

/**
 * 오락실을 찾아 달라는 문장인가 — **모델에 보내지 않고** 바로 찾습니다.
 *
 * 로그인 여부와 상관없이 같은 판단입니다 (B-1). 예전에는 로그인한 사람의 '홍대 사볼' ·
 * '근처 펌프' 가 모델로 가서 실패했고, 같은 문장이 비로그인 · 파인더에서는 됐습니다.
 * - '오락실 찾아줘' 류 · '홍대 사볼' 류 (chat-types.ts)
 * - '근처 · 우리 동네 · 여기' + 묻는 말 없음 ('근처 펌프 있는 곳')
 * - 게임 이름 + 묻는 말 없음 ('펌프', '펌프 있는 곳')
 * - 로그인하지 않은 사람은 오락실 · 게임 이야기면 넓게 받습니다 (자유 질문을 못 하므로)
 */
export function isSearchRequest(
  text: string,
  refined: Pick<RefinedQuery, 'constraints' | 'hint'> | null,
  loggedIn: boolean,
): boolean {
  const c = refined?.constraints ?? null;
  // '즐겨찾기' 의 '찾' 이 찾기 말로 걸리므로 가장 먼저 거른다.
  if (refined?.hint === 'favorites') return false; // 찾기가 아니라 목록 — 화면이 따로 답합니다
  if (isArcadeSearchIntent(text) || looksLikePlaceSearch(text, c)) return true;
  const asks = asksAboutSomething(text);
  if (refined?.hint === 'near' && !asks) return true;
  if (c && c.machineIds.length > 0 && !asks) return true;
  // 묻는 말이 섞이면('펌프 최신 버전 뭐야?') 찾기로 바꿔 답하지 않는다 — 엉뚱한 순위 대신
  // 로그인 안내가 맞다 (UX 시험 B-10).
  if (!loggedIn && !asks && mentionsArcadeTopic(text, c)) return true;
  return false;
}
