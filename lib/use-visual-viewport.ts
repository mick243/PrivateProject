'use client';

import { useLayoutEffect, type RefObject } from 'react';

/** 보이는 영역이 이만큼 넘게 줄면 키보드로 본다 — 주소창이 접히고 펴지는 차이(수십 px)와 가른다 */
const KEYBOARD_MIN_PX = 150;

/** 칸을 누른 뒤 이 시간 안에 생긴 스크롤만 "브라우저가 키보드 때문에 민 것" 으로 보고 되돌린다 */
const RESTORE_WINDOW_MS = 1500;

/**
 * 화면 키보드가 올라와도 패널이 **실제로 보이는 영역**에 맞도록 — 그 영역을 요소의 CSS 변수로 씁니다.
 *
 * 2026-10-02 "모바일에서 챗봇을 켜면 화면이 위로 쭉 밀려난다" 의 원인. iOS(와 기본 설정의
 * 안드로이드 크롬)는 키보드를 화면 **위에 덮습니다.** position: fixed 의 기준(레이아웃
 * 뷰포트)과 100dvh 는 그대로라 아래에 붙인 입력창이 키보드 밑에 깔리고, 브라우저는 그걸
 * 보여 주려고 화면 전체를 밀어 올립니다. 줄어드는 것은 visualViewport 뿐이라 그 값을 씁니다.
 *
 * - `--vv-top` · `--vv-h` — 보이는 영역의 위 끝과 높이. 둘 다 레이아웃 뷰포트 기준이라
 *   fixed 요소의 `top` · `height` 에 그대로 넣으면 브라우저가 화면을 밀어 올려도 따라갑니다.
 * - `data-keyboard` — 키보드가 올라와 있을 때만 붙습니다. CSS 는 평소에는 아래에 붙여 두고,
 *   이게 있을 때만 위의 두 값으로 패널을 키보드 위로 옮깁니다.
 *
 * 리렌더하지 않고 요소의 style 에 바로 씁니다 — 키보드가 올라오는 동안 이벤트가 프레임마다
 * 옵니다. 핀치 줌 중(scale ≠ 1)에는 좌표가 배율만큼 어긋나므로 값을 지워 CSS 기본값으로 둡니다.
 *
 * **브라우저가 민 화면은 되돌립니다.** 입력칸을 누르는 순간에는 패널이 아직 아래에 있어서
 * iOS 가 칸을 보이게 하려고 페이지를 문서 끝까지 밀어 올립니다. 패널은 위 값으로 이미 키보드
 * 위에 붙으므로 밀 필요가 없고, 밀린 채로 두면 문서 끝 아래 — 키보드 위 주소창 뒤 — 에 보여
 * 줄 것이 없어 바탕색 띠가 드러납니다 (2026-10-02 실기기 스크린샷). 그래서 칸을 누르기 직전의
 * 스크롤 자리를 기억해 두고, 키보드가 올라오는 동안에만 그 자리로 돌립니다. 그 뒤에 사용자가
 * 직접 굴린 것은 건드리지 않습니다.
 */
export function useVisualViewportBox(ref: RefObject<HTMLElement | null>, active: boolean): void {
  // 첫 페인트 전에 써야 패널이 기본값 자리에 한 번 그려졌다가 튀지 않습니다
  useLayoutEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!active || !el || !vv) return;

    const clear = () => {
      el.style.removeProperty('--vv-top');
      el.style.removeProperty('--vv-h');
      el.removeAttribute('data-keyboard');
    };

    // 칸을 누르기 직전의 스크롤 자리와, 그리로 되돌려도 되는 마감 시각
    let restY = 0;
    let restoreUntil = 0;
    const onFocusIn = () => {
      restY = window.scrollY;
      restoreUntil = performance.now() + RESTORE_WINDOW_MS;
    };

    let frame = 0;
    const apply = () => {
      frame = 0;
      if (Math.abs(vv.scale - 1) > 0.01) {
        clear();
        return;
      }
      // iOS 는 키보드가 떠도 레이아웃 높이가 그대로라 그 차이가 곧 키보드입니다.
      // 둘 중 큰 쪽과 견줍니다 — 어느 쪽이 키보드를 따라 줄어드는지가 브라우저마다 다릅니다.
      const full = Math.max(document.documentElement.clientHeight, window.innerHeight);
      const keyboard = full - vv.height > KEYBOARD_MIN_PX;
      if (keyboard && performance.now() < restoreUntil && Math.abs(window.scrollY - restY) > 1) {
        // 되돌리면 스크롤 이벤트가 다시 와서 아래 값은 그때 새 자리로 씁니다
        window.scrollTo({ top: restY, behavior: 'instant' });
      }
      el.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      el.style.setProperty('--vv-h', `${vv.height}px`);
      el.toggleAttribute('data-keyboard', keyboard);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    el.addEventListener('focusin', onFocusIn);
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    // 브라우저가 페이지 자체를 굴려 칸을 보이게 하면 visualViewport 가 아니라 창이 스크롤됩니다
    window.addEventListener('scroll', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('focusin', onFocusIn);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', schedule);
      clear();
    };
  }, [ref, active]);
}
