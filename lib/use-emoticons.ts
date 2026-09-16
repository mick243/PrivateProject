'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { Emoticon } from './community-types';

/**
 * 등록된 이모티콘 목록을 앱 전체가 공유하는 스토어 (lib/use-session.ts 와 같은 모양).
 *
 * 한 화면에 고르는 칸과 이모티콘이 박힌 댓글 여러 개가 동시에 뜹니다. 각자
 * 불러오면 같은 목록을 수십 번 받습니다 — 요청은 한 번이고, 갱신되면 모두가
 * 같은 순간에 바뀝니다.
 *
 * 비로그인도 불러옵니다. 남의 댓글에 박힌 `[[emo:N]]` 을 그림으로 그리려면
 * id → 이름 표가 필요하고, 그건 로그인과 무관한 정보입니다.
 */

let current: Emoticon[] = [];
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// getSnapshot 은 렌더마다 불립니다. 매번 새 배열을 만들면 무한 렌더가 됩니다.
function getSnapshot(): Emoticon[] {
  return current;
}

const EMPTY: Emoticon[] = [];
function getServerSnapshot(): Emoticon[] {
  return EMPTY;
}

/**
 * 서버에서 다시 읽어옵니다.
 *
 * 관리자가 등록·삭제한 직후에 부르면 열려 있는 모든 고르는 칸이 같이 바뀝니다.
 */
export async function refreshEmoticons(): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await fetch('/api/emoticons', { cache: 'no-store' });
      const data = (await res.json()) as { emoticons?: Emoticon[] };
      current = data.emoticons ?? [];
    } catch {
      // 목록을 못 받아도 화면이 무너지면 안 됩니다 — 이모티콘 없는 상태로 둡니다.
      current = [];
    } finally {
      loaded = true;
      emit();
      inflight = null;
    }
  })();
  return inflight;
}

export function useEmoticons(): Emoticon[] {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    // 여러 컴포넌트가 동시에 불러도 요청은 한 번뿐입니다 (inflight 공유).
    if (!loaded) void refreshEmoticons();
  }, []);
  return list;
}
