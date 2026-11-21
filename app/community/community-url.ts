import { isPostSort, type PostSort } from '@/lib/board-types';

/**
 * 커뮤니티 화면 상태 ↔ 주소 (`/community?game=3&cat=tip&q=발판&page=2&post=24`).
 *
 * 2026-11-20 UX 시험 C-1: 주소가 늘 `/community` 라 게임 탭 · 검색어가 남지 않았고, 글을 열어도 주소가
 * 그대로라 링크를 나눌 수 없었다. `?post=24` 로 들어와도 열자마자 주소에서 지웠다.
 * 이제 목록 조건은 지금 칸의 주소에 고쳐 적고(replaceState), 글 · 글쓰기는 칸을 하나 쌓는다(pushState).
 *
 * 순수 함수만 둡니다 — 화면(components/CommunityView.tsx)과 테스트가 같이 씁니다.
 */

export interface CommunityListState {
  /** null = '전체' 탭 */
  machineId: number | null;
  category: string | null;
  sort: PostSort;
  /** 조회에 쓰인 검색어 (공백 정리 뒤) */
  q: string;
  /** 1-based */
  page: number;
}

export type CommunityTarget = { kind: 'list' } | { kind: 'detail'; postId: number } | { kind: 'write' };

export const DEFAULT_LIST: CommunityListState = { machineId: null, category: null, sort: 'recent', q: '', page: 1 };

const Q_MAX = 100;
const PAGE_MAX = 10_000;

function positiveInt(raw: string | null, max = Number.MAX_SAFE_INTEGER): number | null {
  if (raw === null || !/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

/** 기본값은 적지 않는다 — `/community` 가 곧 '전체 · 최신순 · 1쪽' */
export function buildCommunityUrl(list: CommunityListState, target: CommunityTarget = { kind: 'list' }): string {
  const p = new URLSearchParams();
  if (list.machineId !== null) p.set('game', String(list.machineId));
  if (list.category !== null) p.set('cat', list.category);
  if (list.sort !== DEFAULT_LIST.sort) p.set('sort', list.sort);
  const q = list.q.trim();
  if (q) p.set('q', q);
  if (list.page > 1) p.set('page', String(list.page));
  if (target.kind === 'detail') p.set('post', String(target.postId));
  if (target.kind === 'write') p.set('write', '1');
  const s = p.toString();
  return s ? `/community?${s}` : '/community';
}

/**
 * 주소를 읽는다. 사람이 고친 주소일 수 있으므로 칸마다 모양을 보고, 깨진 칸은 없는 셈 친다.
 * `hasList` — 목록 조건이 하나라도 주소에 있었나 (있으면 sessionStorage 되살리기보다 주소가 이긴다).
 */
export function parseCommunityUrl(search: string): {
  list: Partial<CommunityListState>;
  hasList: boolean;
  target: CommunityTarget;
} {
  const p = new URLSearchParams(search);
  const list: Partial<CommunityListState> = {};

  const game = positiveInt(p.get('game'));
  if (game !== null) list.machineId = game;
  const cat = p.get('cat');
  if (cat && cat.length <= 40) list.category = cat;
  const sort = p.get('sort');
  if (sort && isPostSort(sort)) list.sort = sort;
  const q = (p.get('q') ?? '').trim();
  if (q) list.q = q.slice(0, Q_MAX);
  const page = positiveInt(p.get('page'), PAGE_MAX);
  if (page !== null) list.page = page;

  const postId = positiveInt(p.get('post'));
  const target: CommunityTarget =
    postId !== null ? { kind: 'detail', postId } : p.get('write') === '1' ? { kind: 'write' } : { kind: 'list' };

  return { list, hasList: Object.keys(list).length > 0, target };
}
