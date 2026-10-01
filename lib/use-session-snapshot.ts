'use client';

import { useEffect, useRef } from 'react';

/**
 * 화면 상태를 **새로고침해도 그 자리로** 돌려놓는다 — sessionStorage 에 적어 두고 마운트 때 되살린다.
 *
 * 2026-10-01 "새로고침하면 처음 화면으로 돌아간다" (파인더 · 커뮤니티 · 실시간 제보). 화면 아래
 * 이동 막대의 새로고침도 `location.reload()` 라(components/HistoryBar.tsx) 필터 · 검색어 · 반경 ·
 * 위치 추적이 전부 기본값으로 돌아갔다.
 *
 * localStorage 가 아니라 sessionStorage 인 이유는 선택한 오락실을 남기는 자리
 * (ArcadeFinder 의 SELECTED_STORE_KEY)와 같다 — "지금 보던 것" 이지 설정이 아니라서, 창을 닫고
 * 내일 다시 켰을 때까지 따라오면 오히려 이상하다. 같은 창에서 다른 탭에 다녀왔을 때도 되살아난다.
 *
 * 마운트 후에 읽는 이유: 서버 렌더에는 sessionStorage 가 없어서, 초기값으로 읽으면 SSR 결과와
 * 어긋나 hydration 이 깨진다. 그래서 첫 화면이 기본값으로 한 번 그려진 뒤 되살아난다.
 *
 * @param snapshot 적어 둘 값 — JSON 으로 바꿀 수 있어야 한다. 바뀔 때마다 다시 적는다.
 * @param restore  마운트 때 한 번, 저장된 값을 받아 state 에 넣는다. 저장값은 사용자가 고칠 수
 *                 있으므로 **칸마다 모양을 확인하고** 넣는다 (깨진 칸은 기본값으로 둔다).
 */
export function useSessionSnapshot<T extends object>(
  key: string,
  snapshot: T,
  restore: (saved: Partial<Record<keyof T, unknown>>) => void,
): void {
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const saved: unknown = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        restoreRef.current(saved as Partial<Record<keyof T, unknown>>);
      }
    } catch {
      // 깨진 저장값은 없는 셈 친다
    }
  }, [key]);

  // 마운트 직후 첫 실행은 건너뛴다 — 그때 값은 되살리기 전의 기본값이라, 적으면 방금 읽은
  // 저장값을 기본값으로 덮는다. 되살린 값이 들어오는 다음 렌더부터 적는다.
  const json = JSON.stringify(snapshot);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    try {
      sessionStorage.setItem(key, json);
    } catch {
      // 시크릿 모드 등에서 저장이 막혀도 화면 동작에는 지장이 없다
    }
  }, [key, json]);
}

/** 저장값 확인용 — 숫자 하나 */
export function savedNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 저장값 확인용 — 문자열 하나 */
export function savedString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 저장값 확인용 — 좌표 한 점 */
export function savedCoord(v: unknown): { lat: number; lng: number } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { lat, lng } = v as { lat?: unknown; lng?: unknown };
  const la = savedNumber(lat);
  const ln = savedNumber(lng);
  return la !== undefined && ln !== undefined && Math.abs(la) <= 90 && Math.abs(ln) <= 180
    ? { lat: la, lng: ln }
    : undefined;
}
