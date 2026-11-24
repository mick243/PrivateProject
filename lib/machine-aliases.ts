/**
 * 기종 **별칭 사전** — 'PIU' · '투덱' · '이지투' · '마이마이' 로 적어도 같은 기종을 찾습니다.
 *
 * 기종 표(machines)에는 정식 명칭과 축약명 하나씩만 있습니다. 축약명이 '펌프' 인 기종을
 * 'PIU' 로 물으면 챗봇 도구가 "기종을 찾지 못했습니다" 를 돌려줬고, 탐색 문장의 '투덱' 은
 * 기종으로 읽히지 않아 지역 이름 후보로 넘어갔습니다 (2026-11-17 점검).
 *
 * 표에 열을 더하지 않고 여기 둡니다. 별칭은 관리자가 고칠 데이터가 아니라 사람들이 쓰는
 * 말버릇이고, 두 군데(챗봇 도구 lib/chat-tools.ts · 문장 제약 lib/query-constraints.ts)가
 * 같은 목록을 읽어야 답이 갈리지 않습니다. 보유 기종 추정(lib/machine-guess.ts)은 아직 쓰지
 * 않습니다 — 그 매칭 규칙은 배치 스크립트(.mjs)에 옮겨 적혀 있어 한쪽만 바꾸면 어긋납니다.
 *
 * 사전의 열쇠는 id 가 아니라 **이름**입니다 — 같은 기종도 DB 마다 id 가 다를 수 있습니다
 * (GUIDELINES.md 4-6). 표에 없는 기종의 항목은 그냥 쓰이지 않습니다.
 *
 * 순수 함수만 둡니다 — 클라이언트 번들에 들어갑니다.
 */

import type { Machine } from './types';

type Named = Pick<Machine, 'name' | 'shortName'>;

/** 이름·문장을 같은 꼴로 — 대소문자와 띄어쓰기는 사람마다 다릅니다 */
export const normTerm = (s: string): string => s.toLowerCase().replace(/\s+/g, '');

/** 이보다 짧은 말은 우연히 걸립니다 */
const MIN_TERM = 2;

/**
 * `of` — 이 항목이 어느 기종의 것인지 가리는 말 (기종의 정식 명칭·축약명 안에 들어 있으면 그 기종).
 * `aliases` — 그 기종을 부르는 다른 말. 전부 normTerm 을 거친 꼴(소문자 · 공백 없음)로 적습니다.
 *
 * 넣는 기준: 2글자 이상이고, 지명이나 흔한 낱말과 겹치지 않을 것. 별칭이 문장에서 걸리면
 * 그 낱말은 지역 이름 후보에서 빠집니다(findPlaceQuery) — 지명과 겹치는 별칭은 지역을 지웁니다.
 *
 * '이지투' 는 EZ2AC 로 봅니다. EZ2DJ 도 이지투라고 부르지만 지금 오락실에서 도는 것은 EZ2AC 이고,
 * 둘 다로 읽으면 기종 필터가 "둘 다 있는 곳"(AND)이 되어 거의 0곳이 됩니다. EZ2DJ 는
 * '이지투디제이' 로 적어야 잡히고, 긴 말이 먼저 먹으므로(matchMachines) 그때 EZ2AC 는 걸리지 않습니다.
 */
const ALIASES: readonly { of: readonly string[]; aliases: readonly string[] }[] = [
  { of: ['pumpitup', '펌프'], aliases: ['piu', '펌프잇업', '펌프잇'] },
  { of: ['beaton', '비트온'], aliases: ['손펌프'] },
  { of: ['ez2ac'], aliases: ['이지투ac', '이지투에이씨', '이지투'] },
  { of: ['ez2dj'], aliases: ['이지투dj', '이지투디제이'] },
  { of: ['soundvoltex', '사볼'], aliases: ['sdvx', '사운드볼텍스', '볼텍스'] },
  { of: ['iidx'], aliases: ['투덱', '2dx', '비트매니아', 'beatmania'] },
  { of: ['태고'], aliases: ['taiko', '타이코'] },
  { of: ['dancedancerevolution', 'ddr'], aliases: ['디디알', '댄스댄스레볼루션'] },
  { of: ['maimai'], aliases: ['마이마이'] },
  { of: ['chunithm', '츄니즘'], aliases: ['chuni', '츄니', '츄니즘'] },
  { of: ['jubeat', '유비트'], aliases: ['유빗', '주비트'] },
  { of: ['gitadora', '기타도라'], aliases: ['기타프릭스', '드럼매니아', 'guitarfreaks', 'drummania'] },
  { of: ['dancerush', '댄스러쉬'], aliases: ['댄스러시'] },
  { of: ["pop'nmusic", '팝픈'], aliases: ['popn', '팝픈뮤직', '팝엔뮤직'] },
  { of: ['노스탤지어'], aliases: ['nostalgia', '노스텔지어', '노스탈지어'] },
];

/**
 * 이 기종을 가리키는 말 전부 — 정식 명칭 · 축약명 · 별칭 (normTerm 꼴, 중복 없음).
 */
export function machineTerms(machine: Named): string[] {
  const own = [normTerm(machine.shortName), normTerm(machine.name)].filter(
    (t) => t.length >= MIN_TERM,
  );
  const extra = ALIASES.filter((entry) => entry.of.some((key) => own.some((t) => t.includes(key))))
    .flatMap((entry) => entry.aliases);
  return [...new Set([...own, ...extra])];
}

/**
 * 문장에 언급된 기종들 (기종 목록의 순서 그대로).
 *
 * **긴 말부터** 맞추고, 맞은 자리는 지웁니다. '이지투디제이' 에서 EZ2DJ 를 잡은 뒤 남은
 * 글자에 '이지투'(EZ2AC)가 다시 걸리면 한 낱말이 두 기종이 됩니다.
 */
export function matchMachines<T extends Named>(text: string, machines: readonly T[]): T[] {
  let rest = normTerm(text);
  if (rest === '') return [];

  const terms = machines
    .flatMap((machine) => machineTerms(machine).map((term) => ({ term, machine })))
    .sort((a, b) => b.term.length - a.term.length);

  const hit = new Set<T>();
  for (const { term, machine } of terms) {
    if (!rest.includes(term)) continue;
    hit.add(machine);
    // 공백으로 메웁니다 — normTerm 을 거친 말에는 공백이 없어, 지운 자리를 건너 이어 붙은
    // 글자가 새 낱말로 읽히지 않습니다.
    rest = rest.split(term).join(' ');
  }
  return machines.filter((m) => hit.has(m));
}

/**
 * **기종 이름 하나**로 받은 말을 기종으로 — 챗봇 도구의 `machine` 인자처럼.
 *
 * 문장과 달리 이쪽은 이름을 덜 적어 오기도 합니다('pump' · 'EZ2'). 그래서 먼저 문장처럼 맞춰
 * 보고, 하나도 없으면 "그 말로 시작하거나 그 말이 들어 있는 기종" 으로 물러섭니다.
 */
export function resolveMachines<T extends Named>(
  name: string | null | undefined,
  machines: readonly T[],
): T[] {
  const needle = normTerm(name ?? '');
  if (needle === '') return [];
  const mentioned = matchMachines(needle, machines);
  if (mentioned.length > 0) return mentioned;
  return machines.filter((m) => machineTerms(m).some((t) => t.includes(needle)));
}
