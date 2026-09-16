'use client';

import { useEffect, useState } from 'react';

/**
 * 화면 아래 가운데에 떠 있는 이동 막대 — 뒤로 · 앞으로 · 새로고침.
 *
 * 브라우저 도구막대의 같은 버튼과 **같은 일**을 합니다. 앱 나름의 이동 규칙을
 * 새로 만들지 않고 히스토리를 그대로 쓰는 것이 핵심입니다 — 커뮤니티가
 * pushState 로 쌓아 둔 화면 단계(목록 → 상세 → 글쓰기)도 이 버튼으로 오갑니다.
 * 그쪽은 popstate 만 보고 있어서 누가 뒤로 보냈는지 구분하지 않습니다
 * (components/CommunityView.tsx 의 onPopState).
 *
 * 자리가 아래 가운데인 이유: 오른쪽 아래는 챗봇 버튼(.chat-fab), 왼쪽 아래는
 * 지도의 내 위치 버튼(.locate-fab)이 이미 쓰고 있습니다.
 */

/**
 * Navigation API 중 여기서 쓰는 것만. 아직 lib.dom 타입에 없어서 직접 적습니다.
 *
 * 이게 필요한 이유는 `history` 로는 **갈 곳이 있는지 알 수 없기** 때문입니다 —
 * `history.length` 는 앞뒤를 합친 수라 뒤로 갈 수 있는지와 무관합니다. 크로미움
 * 계열에만 있고, 없는 브라우저(사파리 등)에서는 두 버튼을 그냥 열어 둡니다.
 */
interface NavigationLike {
  canGoBack?: boolean;
  canGoForward?: boolean;
  addEventListener(type: 'currententrychange', fn: () => void): void;
  removeEventListener(type: 'currententrychange', fn: () => void): void;
}

function navigationApi(): NavigationLike | null {
  if (typeof window === 'undefined') return null;
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  // canGoBack 이 boolean 인 것까지 봐야 합니다 — 이름만 같은 다른 것을 잡지 않게.
  return nav && typeof nav.canGoBack === 'boolean' ? nav : null;
}

export default function HistoryBar() {
  /**
   * 갈 곳이 있는가. null 은 **알 수 없다**는 뜻이고, 그때는 버튼을 열어 둡니다 —
   * 눌러도 아무 일이 없는 편이, 갈 수 있는데 잠겨 있는 것보다 낫습니다.
   *
   * 서버 렌더와 첫 그림은 언제나 null 이라 마크업이 같습니다 (하이드레이션 어긋남
   * 없음). 실제 상태는 아래 effect 가 붙은 뒤에 반영됩니다.
   */
  const [can, setCan] = useState<{ back: boolean; forward: boolean } | null>(null);

  useEffect(() => {
    const nav = navigationApi();
    if (!nav) return;

    let disposed = false;
    const read = () => {
      if (!disposed) setCan({ back: nav.canGoBack === true, forward: nav.canGoForward === true });
    };

    /**
     * ⚠ 이벤트 안에서 **바로** setState 하지 않습니다.
     *
     * Next 의 App Router 는 화면을 옮길 때마다 `history.pushState`/`replaceState` 를
     * **useInsertionEffect 안에서** 부릅니다 (node_modules/next/dist/client/components/
     * app-router.js — useInsertionEffect 블록 안의 pushState/replaceState).
     * Navigation API 의 `currententrychange` 는 그 호출에 **동기로** 딸려 오므로,
     * 이 리스너도 결국 insertion effect 한가운데서 돌게 됩니다. 거기서 상태를
     * 바꾸면 리액트가 정확히 그것을 금지합니다:
     *   "useInsertionEffect must not schedule updates."
     * 링크를 누를 때마다 콘솔에 한 줄씩 쌓이던 것이 이것입니다.
     *
     * 마이크로태스크로 한 칸 미루면 커밋이 끝난 뒤에 갱신됩니다. 사람 눈에는
     * 같은 순간이고(같은 프레임), 리액트가 싫어하는 자리만 벗어납니다.
     */
    const sync = () => queueMicrotask(read);

    read();
    // 히스토리 칸을 옮기거나(뒤로/앞으로) 새로 쌓을 때(pushState) 불립니다.
    nav.addEventListener('currententrychange', sync);
    return () => {
      disposed = true;
      nav.removeEventListener('currententrychange', sync);
    };
  }, []);

  return (
    <nav className="histbar" aria-label="화면 이동">
      <button
        type="button"
        // 아이콘만 있는 버튼이라 접근성 이름이 없으면 "버튼" 으로만 읽힙니다.
        aria-label="뒤로 가기"
        title="뒤로 가기"
        disabled={can !== null && !can.back}
        onClick={() => window.history.back()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M15 5l-7 7 7 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button
        type="button"
        aria-label="앞으로 가기"
        title="앞으로 가기"
        disabled={can !== null && !can.forward}
        onClick={() => window.history.forward()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M9 5l7 7-7 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* 앞의 둘은 '어디로 가는가', 새로고침은 '지금 것을 다시'라 성질이 다릅니다.
          붙여 두면 세 번째도 이동 버튼으로 읽혀서 선 하나로 떼어 놓습니다. */}
      <span className="histbar-sep" aria-hidden="true" />

      <button
        type="button"
        aria-label="새로고침"
        title="새로고침"
        // router.refresh() 가 아니라 통째로 다시 읽습니다 — 옆의 두 버튼이
        // 브라우저 도구막대와 같은 일을 하므로, 이것만 다른 뜻이면 안 됩니다.
        onClick={() => window.location.reload()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M23 4v6h-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </nav>
  );
}
