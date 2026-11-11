/**
 * 나무위키 「오락실/지역」 문서에서 뽑은 점포별 보유 기종을 우리 오락실 행에 짝짓습니다.
 * DB 에 쓰는 일은 scripts/import-namu-machines.ts 가 하고, 여기는 **판단만** 합니다(순수 함수).
 *
 * 왜 짝짓기가 따로 필요한가: 나무위키에는 좌표도 장소 id 도 없습니다. 있는 것은 점포 이름과
 * (적혀 있으면) 주소뿐이고, 둘 다 우리 행과 글자가 다릅니다 —
 *   나무위키 "짱오락실 서울대입구점" · "신 주소: 서울특별시 관악구 관악로15길 6"
 *   우리 행   "짱오락실 서울대입구점" · "서울특별시 관악구 관악로15길 6 짱오락실 서울대입구점"
 * 그래서 주소를 **구 + 도로명 + 건물번호** 열쇠로 바꿔 견주고, 주소가 없거나 안 맞을 때만
 * 같은 구 안에서 이름으로 찾습니다. 확신이 없으면 짝짓지 않습니다 — 엉뚱한 오락실에 기종을
 * 붙이는 것이 빠뜨리는 것보다 훨씬 나쁩니다(제보·필터·챗봇이 그 값을 믿습니다).
 */

import { regionOf } from './region-cluster.ts';

/** 문서 → 시·도. 주소가 "관악구 …" 처럼 시·도 없이 적혀 있을 때 앞에 붙입니다 */
export const DOC_SIDO: Readonly<Record<string, string>> = {
  '서울/강남': '서울특별시',
  '서울/강북': '서울특별시',
  '경기/남부': '경기도',
  '경기/북부': '경기도',
  인천: '인천광역시',
  대전: '대전광역시',
  세종: '세종특별자치시',
  충남: '충청남도',
  충북: '충청북도',
  강원: '강원특별자치도',
  부산: '부산광역시',
  울산: '울산광역시',
  경남: '경상남도',
  대구: '대구광역시',
  경북: '경상북도',
  전남광주: '전남광주통합특별시',
  전북: '전북특별자치도',
  제주: '제주특별자치도',
};

export interface NamuStore {
  doc: string;
  path: string[];
  name: string;
  addresses: string[];
  checked: string | null;
  closed: boolean;
  machines: { game: string; count: number | null }[];
  /**
   * 사람이 확인해 정한 짝 — 우리 오락실의 이름과 주소(그대로). 있으면 자동 짝짓기를 건너뜁니다.
   * id 가 아니라 이름 + 주소인 이유: 같은 데이터 파일을 운영 DB 에도 돌리는데, DB 마다 id 가
   * 다를 수 있습니다(GUIDELINES §4-6 "id 를 믿지 마세요").
   */
  arcadeRef?: { name: string; address: string };
  /** 예전 형식 — 개발 DB 의 id. arcadeRef 가 없을 때만 봅니다 */
  arcadeId?: number;
  /** 사람이 넣지 않기로 한 이유 — 있으면 건너뜁니다 */
  skip?: string;
}

export interface DbArcade {
  id: number;
  name: string;
  address: string;
}

export type MatchBy = 'address' | 'address+name' | 'name' | 'manual';

export type Match =
  | { kind: 'matched'; arcadeId: number; by: MatchBy; nameScore: number }
  | { kind: 'ambiguous'; candidates: number[]; by: MatchBy }
  | { kind: 'none' };

/** 구가 있으면 구(자치구·일반구), 없으면 시·군 — 도로명이 겹치지 않는 가장 좁은 단위 */
function areaOf(address: string, sido: string | null): string | null {
  const r = regionOf(address) ?? (sido ? regionOf(`${sido} ${address}`) : null);
  if (!r) return null;
  return r.districtBy === 'gu' && r.district ? r.district.key : r.city.key;
}

const ROAD_RE = /([가-힣A-Za-z0-9·.]+(?:로|길))\s*(?:지하\s*)?(\d+(?:-\d+)?)/g;
/** 지번 — "봉천동 123-4" · "종로1가 12" · "산16-4" */
const JIBUN_RE = /([가-힣]+[0-9]*(?:동|가|리))\s+(산?\d+(?:-\d+)?)/g;

/**
 * 주소 한 줄 → 열쇠들. 한 줄에 "(구)…(신)…" 처럼 둘이 붙어 와도 각각 뽑습니다.
 * 구·시를 못 읽으면 열쇠를 만들지 않습니다 — 도로명만으로는 전국에서 겹칩니다.
 */
export function addressKeys(address: string, sido: string | null = null): string[] {
  const keys = new Set<string>();
  // "(구)" "(신)" "구 주소:" 같은 머리말로 나뉜 여러 주소를 따로 본다
  const parts = address
    .split(/\((?:구|신)\)|(?:구|신)\s*주소\s*[:：]|\s\/\s/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const raw of parts.length ? parts : [address]) {
    // "고현로 11길 14" · "아주1로 2길 19" 처럼 도로명 가운데를 띄어 쓴 것을 붙인다 —
    // 안 붙이면 "고현로 11" 로 읽혀 우리 행의 "고현로11길 14" 와 어긋난다.
    const part = raw.replace(/(로|길)\s+(\d+(?:번)?(?:길|로))(?=\s|$|,)/g, '$1$2');
    const area = areaOf(part, sido);
    if (!area) continue;
    for (const m of part.matchAll(ROAD_RE)) keys.add(`${area}|${m[1].replace(/\s+/g, '')}|${m[2]}`);
    for (const m of part.matchAll(JIBUN_RE)) keys.add(`${area}|${m[1]}|${m[2]}`);
  }
  return [...keys];
}

/** 이름 견주기용 — 표식(ⓐⓝ)·괄호 안·기호·띄어쓰기를 뗍니다 */
export function nameKey(name: string): string {
  return name
    .replace(/[ⓐ-ⓩ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, '');
}

/** 가게 이름이라기보다 업종인 낱말 (nameKey 꼴) */
const GENERIC_NAMES = new Set(['오락실', '전자오락실', '게임장', '게임존', '게임랜드', '게임센터', '오락장', '게임방', '게임월드', '게임파크']);

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * 지점명 — "…점" 으로 끝나는 마지막 낱말 ("짱오락실 신림점" → "신림점"). 없으면 null.
 * 마지막 낱말만 보지 않는 이유: "짱오락실 부산삼정타워점 & 히어로 보드게임카페" 처럼 지점명 뒤에
 * 다른 말이 붙으면 지점이 없는 이름으로 읽혀, 지점명 없는 "짱오락실"(다른 지점)에 짝지어졌다.
 */
function branchOf(name: string): string | null {
  const words = name.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim().split(/\s+/);
  const branch = words.slice(1).filter((w) => /점$/.test(w) && w.length >= 2).at(-1);
  return branch ?? null;
}

/**
 * 두 이름이 같은 가게를 가리키는 정도(0~1).
 *
 *   같으면 1. 지점명이 같거나 둘 다 없을 때만 —
 *     한쪽이 다른 쪽을 통째로 품으면 0.9 ("노량진 어뮤즈타운" ↔ "어뮤즈타운")
 *     짧은 쪽 글자쌍이 긴 쪽에 얼마나 들어 있나 × 0.8 ("잠실 롯데월드 … 아이스가든 펀시티" ↔ "롯데월드 펀시티")
 *   그 밖은 글자쌍 겹침(Dice 계수).
 *
 * 지점명이 다르면 품기·들어 있기를 보지 않습니다 — "대빵오락실 강남점" 이 지점명 없는 "대빵오락실" 에
 * 통째로 들어 있다고 같은 가게는 아닙니다(체인은 같은 구에 여럿 있습니다).
 */
export function nameScore(a: string, b: string): number {
  return Math.max(...altNames(a).flatMap((x) => altNames(b).map((y) => scoreOne(x, y))));
}

/**
 * 이름 하나에서 견줄 이름들 — 이름 그대로 + 괄호 속 이름(앞의 "구 " 를 뗀 것).
 *
 * 나무위키는 다른 이름·옛 이름을 괄호에 적습니다 — "부천 P2존 (뽀끼뽀끼 오락실)",
 * "G-존(스페이스멀티게임존)", "댓거리 가족게임랜드 (구 자바게임랜드)". 괄호를 지우기만 하면
 * 우리 행("뽀끼뽀끼오락실")과 겹치는 글자가 하나도 없어 점수가 0 이 됩니다.
 */
function altNames(name: string): string[] {
  const inner = [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.replace(/^\s*구\s+/, '').trim());
  return [name, ...inner.filter((s) => nameKey(s).length >= 2)];
}

function scoreOne(a: string, b: string): number {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const sameBranch = branchOf(a) === branchOf(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // 흔한 낱말("오락실" · "게임존")이 통째로 들어 있다고 같은 가게가 아니다 — "메가박스 오락실" 이
  // 양주의 "오락실" 에, "롯데호텔 제주 … 게임존" 이 표선의 "게임존" 에 짝지어진 적이 있다.
  if (sameBranch && short.length >= 4 && !GENERIC_NAMES.has(short) && long.includes(short)) return 0.9;

  const bx = bigrams(x);
  const by = bigrams(y);
  if (bx.length === 0 || by.length === 0) return 0;
  const pool = [...by];
  let hit = 0;
  for (const g of bx) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  const dice = (2 * hit) / (bx.length + by.length);
  const contained = hit / Math.min(bx.length, by.length);
  return sameBranch && short.length >= 4 ? Math.max(dice, contained * 0.8) : dice;
}

/** 후보 여럿 중 이름으로 하나를 고를 때 — 1등이 이만큼은 되고, 2등보다 이만큼 앞서야 한다 */
const PICK_MIN = 0.5;
const PICK_MARGIN = 0.15;
/** 주소가 없어 이름만으로 고를 때는 더 엄격하게 */
const NAME_ONLY_MIN = 0.75;
/**
 * 주소가 하나로 맞아도 이름이 이보다 덜 닮았으면 짝짓지 않고 애매로 돌립니다.
 * 같은 자리에 가게가 바뀌었거나("비잉비잉 광안점" ↔ "핑키펑키 버니하우스 광안점") 한 건물의
 * 다른 가게일 수 있습니다. 사람이 보고 맞으면 데이터에 arcadeId 를 적습니다.
 */
export const ADDRESS_NAME_MIN = 0.2;

function pickByName(store: NamuStore, cands: DbArcade[], min: number): DbArcade | null {
  const scored = cands
    .map((a) => ({ a, s: nameScore(store.name, a.name) }))
    .sort((p, q) => q.s - p.s);
  const [first, second] = scored;
  if (!first || first.s < min) return null;
  if (second && first.s - second.s < PICK_MARGIN) return null;
  return first.a;
}

/** 점포가 있는 구·시 — 주소에서, 없으면 문서 + 제목 경로에서 */
export function storeArea(store: NamuStore): string | null {
  const sido = DOC_SIDO[store.doc] ?? null;
  for (const a of store.addresses) {
    const area = areaOf(a, sido);
    if (area) return area;
  }
  return sido ? areaOf(`${sido} ${store.path.join(' ')}`, null) : null;
}

/**
 * 점포 하나를 우리 오락실 하나에 짝짓습니다.
 *
 *   1. 주소 열쇠가 같은 행이 하나 → 그 행 (by: address)
 *      여럿(한 건물에 여러 오락실) → 이름으로 고름 (by: address+name), 못 고르면 ambiguous
 *   2. 주소로 못 찾으면 같은 구·시 안에서 이름 (by: name) — 거의 같을 때만
 */
export function matchStore(store: NamuStore, arcades: readonly DbArcade[], index: ArcadeIndex): Match {
  // 사람이 정한 짝이 먼저다. 그 행이 없으면 짝짓지 않는다(지워졌거나 다른 DB 라 없는 행에 붙이지 않게).
  if (store.arcadeRef || store.arcadeId !== undefined) {
    const ref = store.arcadeRef;
    const found = ref
      ? arcades.filter((x) => x.name === ref.name && x.address === ref.address)
      : arcades.filter((x) => x.id === store.arcadeId);
    const a = found.length === 1 ? found[0] : undefined;
    return a ? { kind: 'matched', arcadeId: a.id, by: 'manual', nameScore: nameScore(store.name, a.name) } : { kind: 'none' };
  }
  const sido = DOC_SIDO[store.doc] ?? null;
  const keys = new Set(store.addresses.flatMap((a) => addressKeys(a, sido)));

  const byAddress = new Map<number, DbArcade>();
  for (const k of keys) for (const a of index.byKey.get(k) ?? []) byAddress.set(a.id, a);
  const addrCands = [...byAddress.values()];

  if (addrCands.length === 1) {
    const a = addrCands[0];
    const score = nameScore(store.name, a.name);
    return score >= ADDRESS_NAME_MIN
      ? { kind: 'matched', arcadeId: a.id, by: 'address', nameScore: score }
      : { kind: 'ambiguous', candidates: [a.id], by: 'address' };
  }
  if (addrCands.length > 1) {
    const picked = pickByName(store, addrCands, PICK_MIN);
    return picked
      ? { kind: 'matched', arcadeId: picked.id, by: 'address+name', nameScore: nameScore(store.name, picked.name) }
      : { kind: 'ambiguous', candidates: addrCands.map((a) => a.id), by: 'address+name' };
  }

  const area = storeArea(store);
  if (!area) return { kind: 'none' };
  const sameArea = index.byArea.get(area) ?? [];
  const close = sameArea.filter((a) => nameScore(store.name, a.name) >= PICK_MIN);
  if (close.length === 0) return { kind: 'none' };
  const picked = pickByName(store, close, NAME_ONLY_MIN);
  if (!picked) return { kind: 'ambiguous', candidates: close.map((a) => a.id), by: 'name' };
  // 주소 없이 이름만으로 짝지을 때, 우리 쪽 이름이 체인 이름뿐("짱오락실")이면 같은 구의 다른 지점일 수
  // 있다 — "이천 짱오락실"(어재연로)이 부발읍의 "짱오락실" 에 붙을 뻔했다. 이름이 완전히 같거나,
  // 그 이름이 전국에 하나뿐일 때만 짝짓는다.
  const score = nameScore(store.name, picked.name);
  const uniqueName = (index.nameCount.get(nameKey(picked.name)) ?? 0) <= 1;
  return score === 1 || uniqueName
    ? { kind: 'matched', arcadeId: picked.id, by: 'name', nameScore: score }
    : { kind: 'ambiguous', candidates: close.map((a) => a.id), by: 'name' };
}

export interface ArcadeIndex {
  byKey: Map<string, DbArcade[]>;
  byArea: Map<string, DbArcade[]>;
  /** 이름(nameKey)별 전국 행 수 — 체인 이름인지 가르는 데 씁니다 */
  nameCount: Map<string, number>;
}

/** 우리 오락실들을 주소 열쇠 · 구별로 묶어 둡니다 (점포마다 926곳을 다 훑지 않게) */
export function indexArcades(arcades: readonly DbArcade[]): ArcadeIndex {
  const byKey = new Map<string, DbArcade[]>();
  const byArea = new Map<string, DbArcade[]>();
  const nameCount = new Map<string, number>();
  for (const a of arcades) {
    const nk = nameKey(a.name);
    nameCount.set(nk, (nameCount.get(nk) ?? 0) + 1);
    for (const k of addressKeys(a.address)) {
      const list = byKey.get(k) ?? [];
      list.push(a);
      byKey.set(k, list);
    }
    const area = areaOf(a.address, null);
    if (area) {
      const list = byArea.get(area) ?? [];
      list.push(a);
      byArea.set(area, list);
    }
  }
  return { byKey, byArea, nameCount };
}
