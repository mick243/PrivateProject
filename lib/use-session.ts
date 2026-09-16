'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { SessionUser } from './auth-types';

/**
 * "지금 로그인한 사람"을 앱 전체가 공유하는 스토어.
 *
 * 근거는 서버가 서명한 **세션 쿠키** 하나입니다. "누구로 활동하는가"도 여기서
 * 갈라져 나갑니다 (lib/use-player.ts) — 예전에는 localStorage 에 적힌 선택이
 * 따로 있었지만, 근거가 둘이면 OAuth 로그인처럼 한쪽만 갱신되는 길에서 어긋납니다.
 *
 * 화면이 관리자 버튼을 그릴지만 여기서 정하고, 실제 권한 판정은 언제나 서버가
 * 합니다 (lib/auth.ts requireAdmin). 이 값을 조작해도 API 가 401/403 을 돌려줍니다.
 */

let current: SessionUser | null = null;
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

// getSnapshot 은 렌더마다 불리므로 매번 새 객체를 만들면 무한 렌더가 됩니다.
// 로그인/로그아웃으로 값이 바뀔 때만 참조를 갈아 끼웁니다.
function getSnapshot(): SessionUser | null {
  return current;
}

/** SSR 에서는 항상 비로그인 — 서버 렌더 시점에는 쿠키를 읽지 않습니다 */
function getServerSnapshot(): SessionUser | null {
  return null;
}

export function setSession(user: SessionUser | null): void {
  current = user;
  loaded = true;
  emit();
}

/** 세션을 서버에서 다시 읽어옵니다 (첫 마운트 · 로그인/로그아웃 직후) */
export async function refreshSession(): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' });
      const data = (await res.json()) as { user: SessionUser | null };
      current = data.user ?? null;
    } catch {
      // 네트워크가 죽었다고 관리자 버튼이 생기면 안 되므로 비로그인으로 둡니다.
      current = null;
    } finally {
      loaded = true;
      checkedAt = Date.now();
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

/**
 * 마지막으로 서버에 물어본 시각. 탭을 다시 볼 때마다 묻지 않기 위한 간격입니다.
 * 세션은 7일짜리라 1분 간격이면 충분히 촘촘합니다.
 */
let checkedAt = 0;
const RECHECK_MS = 60_000;

/**
 * 탭으로 돌아왔을 때 세션이 아직 살아 있는지 확인합니다.
 *
 * 고치는 문제: 세션은 7일이면 끝나는데 화면은 **처음 마운트할 때 한 번만** 물었습니다.
 * 그래서 탭을 열어 둔 채 만료되면 상단에 닉네임이 그대로 남고 글쓰기 버튼도 살아
 * 있는데, 누르는 것마다 401 로 떨어졌습니다 (2026-09-13 UX 점검). 다른 기기에서
 * 로그아웃했거나 관리자 권한이 회수된 경우도 같습니다.
 *
 * 모든 fetch 를 감싸 401 을 가로채는 방법도 있지만, 호출부가 마흔 곳이 넘고 그중
 * 상당수는 401 을 이미 자기 방식으로 다룹니다. 돌아온 순간에 한 번 묻는 쪽이
 * 작고, 사람이 실제로 겪는 경우(오래 열어 둔 탭)를 그대로 덮습니다.
 */
function recheckIfStale(): void {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - checkedAt < RECHECK_MS) return;
  checkedAt = Date.now();
  void refreshSession();
}

export function useSession(): SessionUser | null {
  const user = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // 여러 컴포넌트가 동시에 불러도 요청은 한 번뿐입니다 (inflight 공유).
  useEffect(() => {
    if (!loaded) {
      checkedAt = Date.now();
      void refreshSession();
    }
    document.addEventListener('visibilitychange', recheckIfStale);
    window.addEventListener('focus', recheckIfStale);
    return () => {
      document.removeEventListener('visibilitychange', recheckIfStale);
      window.removeEventListener('focus', recheckIfStale);
    };
  }, []);
  return user;
}

/** 관리자 전용 UI 의 표시 조건 */
export function useIsAdmin(): boolean {
  return useSession()?.isAdmin === true;
}
