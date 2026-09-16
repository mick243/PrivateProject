'use client';

import type { PostDetail } from './board-types';

/**
 * 글 상세를 담아 두는 곳 — 목록에서 상세로 넘어가는 순간의 대기를 없애기 위한 것.
 *
 * ─── 왜 필요한가 ───
 * 목록의 한 줄을 누르면 상세 컴포넌트가 마운트되고 **그때** 조회가 시작됩니다.
 * 클릭에서 첫 글자가 보이기까지 왕복 하나가 통째로 들어가는데, 그 왕복은 사용자가
 * 마우스 버튼을 누른 시점에 이미 시작할 수 있습니다 (누르고 떼는 데 보통
 * 50~150ms 가 걸리고, 그 사이 React 마운트도 끝납니다).
 *
 * ─── 요청 수는 늘지 않습니다 ───
 * 미리 받는 요청은 상세가 어차피 보낼 그 요청과 **같은 것**입니다 (조회수 파라미터
 * 까지 같습니다). 같은 키의 요청이 이미 떠 있으면 그것을 함께 기다리므로
 * (`inflight`), 미리 받기 + 상세 마운트로 두 번 나가지 않습니다.
 *
 * 그래서 미리 받기는 **마우스 pointerdown 에서만** 겁니다. hover 에서 걸면 조회수를
 * 올리지 않는 별도 요청이 필요해져(스쳐 지나간 글의 조회수가 오르면 안 됩니다)
 * 결국 요청이 두 번 나갑니다. 터치는 아예 걸지 않습니다 — 손가락이 닿는 것은
 * 스크롤의 시작일 수도 있어서, 그것으로 조회수를 올릴 수는 없습니다.
 */

/** 담아 두는 글 수. 넘으면 가장 오래 전에 담은 것부터 버립니다 (본문이 큰 글도 있음) */
const MAX_ENTRIES = 20;

export interface PostKey {
  postId: number;
  /** 내 추천 여부가 응답에 실리므로 사람이 다르면 다른 캐시입니다 */
  playerId: number | null;
  /** 댓글 페이지 시작 위치 */
  commentOffset: number;
}

interface Entry {
  post: PostDetail;
  /** 담은 시각. 오래된 것을 조용히 다시 받는 판단에 씁니다 */
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<PostDetail | null>>();

/**
 * 이 세션에서 조회수를 이미 올린 글.
 *
 * 상세를 열 때마다 올리지 않고 처음 한 번만 올립니다 — 예전에도 같은 의도였지만
 * (PostDetailView 의 viewedPostId ref) 상세를 닫으면 ref 가 사라져서 뒤로 갔다
 * 다시 들어오면 또 올랐습니다. 이제 목록으로 돌아가도 이 Set 은 남습니다.
 */
const viewed = new Set<number>();

function keyOf({ postId, playerId, commentOffset }: PostKey): string {
  return `${postId}:${playerId ?? 0}:${commentOffset}`;
}

/** 담아 둔 것이 있으면 담은 뒤 얼마나 지났는지와 함께 준다 (없으면 undefined) */
export function peekPost(key: PostKey): { post: PostDetail; ageMs: number } | undefined {
  const hit = cache.get(keyOf(key));
  return hit ? { post: hit.post, ageMs: Date.now() - hit.at } : undefined;
}

export function rememberPost(key: PostKey, post: PostDetail): void {
  const k = keyOf(key);
  // 다시 담을 때도 순서를 갱신해야 '오래된 것부터 버리기' 가 맞는다
  cache.delete(k);
  cache.set(k, { post, at: Date.now() });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/**
 * 이 글의 담아 둔 것을 모두 버립니다 (댓글 페이지·사람 구분 없이).
 * 추천·댓글·수정처럼 내용이 바뀌는 일이 있은 뒤에 부릅니다.
 */
export function forgetPost(postId: number): void {
  for (const k of [...cache.keys()]) {
    if (k.startsWith(`${postId}:`)) cache.delete(k);
  }
}

/** 이 글의 조회수를 이 세션에서 아직 올리지 않았나 */
export function needsViewCount(postId: number): boolean {
  return !viewed.has(postId);
}

/**
 * 상세를 받아 담아 둡니다. 같은 키의 요청이 떠 있으면 그것을 함께 기다립니다.
 *
 * `countView` 는 조회수를 올릴지 — 서버가 같은 왕복에서 처리합니다
 * (lib/board.ts getPost). 성공하면 이 세션에서는 다시 올리지 않습니다.
 */
export function fetchPost(key: PostKey, countView: boolean): Promise<PostDetail | null> {
  const k = keyOf(key);

  const running = inflight.get(k);
  if (running) return running;

  // playerId 는 **보내지 않습니다** — 내 추천 여부는 서버가 세션에서 읽습니다.
  // 그래도 키에는 남깁니다: 로그아웃하거나 다른 계정으로 들어오면 같은 글이라도
  // 응답이 달라지므로, 키가 같으면 앞사람의 화면을 그대로 보여주게 됩니다.
  const params = new URLSearchParams({ commentOffset: String(key.commentOffset) });
  if (countView) {
    params.set('view', '1');
    // 응답을 기다리지 않고 표시합니다 — 같은 글로 요청이 몰릴 때 조회수가
    // 여러 번 오르지 않게 하는 것이 목적이고, 실패하면 다음 열기에 올라갑니다.
    viewed.add(key.postId);
  }

  const p = fetch(`/api/posts/${key.postId}?${params}`)
    .then((r) => r.json())
    .then((d) => {
      const post = (d.post ?? null) as PostDetail | null;
      if (post) rememberPost(key, post);
      return post;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(k);
    });

  inflight.set(k, p);
  return p;
}

/** 미리 받기 — 결과는 캐시로만 쓰고 실패는 무시합니다 */
export function prefetchPost(key: PostKey): void {
  if (cache.has(keyOf(key))) return;
  void fetchPost(key, needsViewCount(key.postId));
}

/**
 * 담아 둔 것을 그대로 써도 되는 시간. 넘으면 화면은 담아 둔 것으로 **즉시** 그리고
 * 뒤에서 조용히 다시 받아 덮습니다 (스피너 없음).
 *
 * 미리 받기 → 열기 는 1초 안에 일어나므로 그 길은 언제나 요청 하나입니다. 이 값이
 * 막는 것은 "뒤로 갔다가 한참 뒤에 다시 들어와 옛 댓글 수를 보는" 경우입니다.
 */
export const POST_STALE_MS = 15_000;
