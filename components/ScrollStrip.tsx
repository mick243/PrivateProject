'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 한 줄로 두고 옆으로 스크롤하는 줄 — 넘치는 **쪽에만** 화살표가 붙습니다.
 *
 * 항목이 계속 늘어나는 줄(기종 목록 같은)을 접히게 두면 화면 폭에 따라 두 줄·세 줄이
 * 되면서 그 아래 내용이 오르내립니다. 줄 높이가 고정되어야 아래가 늘 같은 자리에 있습니다.
 *
 * 대신 옆으로 넘긴 자리는 보이지 않으므로, 스크롤 막대를 숨긴 자리에 화살표를 띄웁니다 —
 * 마우스에는 가로로 미는 손쉬운 방법이 없어서 이게 안내이자 조작 수단입니다.
 *
 * 쓰는 곳: 커뮤니티 게임 탭(components/GameTabs.tsx), 사이드바 기종 필터
 * (components/ArcadeFinder.tsx). 줄의 생김새(여백·경계선·칩 모양)는 `className` 으로
 * 받은 기존 클래스가 그대로 정하고, 여기서는 **넘침만** 다룹니다.
 */

interface Props {
  children: ReactNode;
  /** 줄 자체에 붙일 기존 클래스 (`game-tabs` · `chips`) */
  className: string;
  /** 바깥 칸에 붙일 클래스. 여백과 `--strip-pad`(화살표가 비켜야 할 아래 높이)를 정한다 */
  wrapClassName?: string;
  /** 시맨틱이 필요한 곳(탭 줄)은 nav 로 */
  as?: 'div' | 'nav';
  /**
   * 이 값이 바뀌면 다시 잽니다.
   *
   * 항목이 늘어나는 것은 **관찰 대상의 박스 크기를 바꾸지 않아** ResizeObserver 가 잡지
   * 못합니다 (넘치는 양만 늘 뿐 줄의 폭은 그대로입니다). 목록이 fetch 로 늦게 오는
   * 줄에서는 이게 유일한 계기이므로, 개수처럼 바뀌면 다시 재야 하는 값을 넘기세요.
   */
  remeasureKey?: string | number;
  /**
   * 이 값이 바뀔 때 켜져 있는 항목(`.is-on`)을 보이는 자리로 끌어옵니다.
   *
   * **하나만 고르는 줄에서만 넘기세요.** 여러 개를 켜는 줄(사이드바 기종 필터)에서는
   * 칩 하나를 켤 때마다 줄이 첫 번째 켜진 칩으로 끌려가 방금 누른 자리를 잃습니다.
   */
  revealKey?: string | number;
}

/** 화살표 한 번에 옮기는 거리 — 보이는 폭에 대한 비율. 1 이면 보던 것이 전부 사라진다 */
const PAGE_RATIO = 0.8;

/**
 * 끝에 닿았는지 볼 때 두는 여유(px).
 *
 * scrollLeft·scrollWidth 는 소수로 옵니다 (브라우저 확대·고DPI). 0 과 최대값에 정확히
 * 맞춰 비교하면 끝까지 밀어도 1px 이 남아 화살표가 사라지지 않습니다.
 */
const EDGE_SLACK = 2;

export default function ScrollStrip({
  children,
  className,
  wrapClassName,
  as: Track = 'div',
  remeasureKey,
  revealKey,
}: Props) {
  const trackRef = useRef<HTMLElement>(null);

  /** 넘치지 않으면 양쪽 다 true — 화살표가 하나도 안 뜬다 */
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= EDGE_SLACK);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - EDGE_SLACK);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    measure();

    /*
      폭이 바뀌어도 넘침 여부가 바뀐다. window 의 resize 만 보면 창 크기는 그대로인 채
      이 줄만 좁아지는 경우(사이드바 접기·글꼴 로드)를 놓치므로 요소를 직접 지켜본다.
    */
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [measure, remeasureKey]);

  /**
   * 켜져 있는 항목을 보이는 자리로. `inline` 만 옮기고 `block` 은 'nearest' 로 둡니다 —
   * 세로로 이미 보이는 상태면 페이지가 위아래로 튀지 않습니다.
   */
  useEffect(() => {
    if (revealKey === undefined) return;
    trackRef.current
      ?.querySelector<HTMLElement>('.is-on')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [revealKey, remeasureKey]);

  const nudge = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * PAGE_RATIO, behavior: 'smooth' });
  };

  /*
    화살표는 마우스용 보조 장치라 키보드·낭독기에서는 감춥니다. 키보드로 항목을 넘기면
    브라우저가 focus 를 따라 알아서 줄을 밀어 주므로, 여기 focus 를 한 칸 더 세우면
    같은 일을 하는 버튼을 두 번 지나게 됩니다.
  */
  const arrow = (dir: -1 | 1, show: boolean) =>
    show ? (
      <button
        type="button"
        className={dir === -1 ? 'scroll-strip-arrow is-left' : 'scroll-strip-arrow is-right'}
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => nudge(dir)}
      >
        {dir === -1 ? '‹' : '›'}
      </button>
    ) : null;

  return (
    <div className={wrapClassName ? `scroll-strip ${wrapClassName}` : 'scroll-strip'}>
      {arrow(-1, !atStart)}
      <Track
        className={`scroll-strip-track ${className}`}
        ref={trackRef as React.Ref<HTMLDivElement & HTMLElement>}
        onScroll={measure}
      >
        {children}
      </Track>
      {arrow(1, !atEnd)}
    </div>
  );
}
