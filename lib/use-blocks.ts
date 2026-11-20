'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { BlockedPlayer } from './moderation-types';
import { usePlayerId } from './use-player';

/**
 * 내가 차단한 사람 — 화면 전체가 같은 목록을 봅니다 (GET /api/blocks).
 *
 * 가리기를 서버 SQL 이 아니라 화면에서 하는 이유: 게시판 목록 · 리뷰 · 채보 평가는 모두가 같은
 * 응답을 받는 자리라, 사람마다 조건이 붙으면 캐시와 쪽 나누기가 사람마다 갈립니다. 차단은 몇 명
 * 규모이고 작성자 id 가 이미 응답에 있으므로(playerId) 화면에서 거르면 됩니다.
 *
 * lib/use-session.ts 와 같은 모양의 모듈 스토어입니다 — 상세 패널 · 게시판 · 서열표가 따로따로
 * 불러오면 차단 직후 한쪽만 바뀝니다.
 */

const EMPTY: ReadonlySet<number> = new Set();

let players: BlockedPlayer[] = [];
let ids: ReadonlySet<number> = EMPTY;
/** 지금 목록이 누구의 것인지. 로그아웃 · 다른 계정으로 바뀌면 다시 받습니다 */
let loadedFor: number | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply(next: BlockedPlayer[]): void {
  players = next;
  ids = new Set(next.map((p) => p.playerId));
  emit();
}

async function load(playerId: number): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await fetch('/api/blocks', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { blocked: BlockedPlayer[] };
      loadedFor = playerId;
      apply(data.blocked ?? []);
    } catch {
      // 못 받으면 아무것도 가리지 않습니다 — 가리는 쪽이 틀리면 남의 글이 사라져 보입니다.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 로그인한 사람이 바뀌면 목록을 맞춥니다. 화면 곳곳의 훅이 부르지만 요청은 한 번만 나갑니다 */
function useSync(): void {
  const playerId = usePlayerId();
  useEffect(() => {
    if (playerId === null) {
      if (loadedFor !== null) {
        loadedFor = null;
        apply([]);
      }
      return;
    }
    if (loadedFor !== playerId) void load(playerId);
  }, [playerId]);
}

/** 차단한 사람의 id 묶음 — 목록에서 거를 때 */
export function useBlockedIds(): ReadonlySet<number> {
  useSync();
  return useSyncExternalStore(subscribe, () => ids, () => EMPTY);
}

/** 차단한 사람 목록 — 계정 화면의 관리 칸 */
export function useBlockedPlayers(): BlockedPlayer[] {
  useSync();
  return useSyncExternalStore(
    subscribe,
    () => players,
    () => players,
  );
}

/**
 * 차단하거나 풉니다. 실패하면 사용자에게 보여 줄 문구, 성공하면 null.
 * 성공하면 목록을 낙관적으로 바꿔 화면 곳곳이 바로 가립니다.
 */
export async function setBlocked(target: { playerId: number; nickname: string }, blocked: boolean): Promise<string | null> {
  try {
    const res = blocked
      ? await fetch('/api/blocks', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId: target.playerId }),
        })
      : await fetch(`/api/blocks?playerId=${target.playerId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? '처리하지 못했습니다';
    }
  } catch {
    return '네트워크 오류';
  }
  if (blocked) {
    if (!ids.has(target.playerId)) {
      apply([{ playerId: target.playerId, nickname: target.nickname, createdAt: new Date().toISOString() }, ...players]);
    }
  } else {
    apply(players.filter((p) => p.playerId !== target.playerId));
  }
  return null;
}
