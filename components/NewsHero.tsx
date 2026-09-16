'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PostSummary } from '@/lib/board-types';

/**
 * 홈 맨 위 소식 배너 — 배경 위에 글 제목을 얹고 옆으로 넘깁니다.
 *
 * ─── 왜 스크롤 스냅인가 ───────────────────────────────────
 * 넘기는 동작을 손으로 만들지 않고 `scroll-snap` 에 맡깁니다. 그러면 폰의 관성
 * 스크롤·트랙패드 가로 스와이프·휠이 **브라우저 것** 그대로 동작하고, 키보드와
 * 스크린리더도 목록을 그냥 읽습니다. 직접 만든 드래그 핸들러는 그 셋을 전부
 * 다시 구현해야 하고 보통 하나씩 빠집니다.
 *
 * 지금 어느 칸인지는 스크롤 위치로 되짚습니다(onScroll). 상태로 밀지 않는 이유는
 * 손가락으로 반쯤 넘기다 놓는 경우가 있어서입니다 — 브라우저가 정한 자리가 정답입니다.
 *
 * ─── 마지막에서 처음으로 갈 때 ─────────────────────────────
 * 그냥 0번으로 scrollTo 하면 화면이 오른쪽으로 **되감깁니다** — 계속 넘기던 방향과
 * 반대라 "끝났다" 가 아니라 "튕겨 나왔다" 로 보입니다. 그래서 맨 뒤에 **0번의 사본**을
 * 한 장 붙여 둡니다. 마지막에서 한 번 더 넘기면 그 사본까지 왼쪽으로 이어서 가고,
 * 멈춘 뒤에 애니메이션 없이 진짜 0번으로 바꿔치기합니다. 사본과 0번은 같은 그림이라
 * 바꿔치는 순간이 보이지 않습니다.
 *
 * 거꾸로(0번에서 '이전')도 같은 사본으로 풉니다 — 먼저 사본으로 소리 없이 옮겨 두면
 * 화면은 그대로 0번인데 위치만 맨 뒤라, 거기서 마지막 칸으로 평범하게 되돌아갑니다.
 *
 * ─── 배경이 없는 글이 대부분입니다 ─────────────────────────
 * 첨부가 있으면 그 이미지를 깔고, 없으면 게임 이름에서 고른 어두운 한랭색으로
 * 칠합니다. 빈 회색을 깔면 "이미지를 못 불러왔다" 로 읽히는데, 사실은 **글에 사진이
 * 없는** 것이라 다르게 보여야 합니다. 영상 첨부는 배경으로 쓰지 않습니다(mime 확인).
 */

const AUTO_MS = 6000;
/** 스크롤이 멎었다고 볼 때까지 기다리는 시간. 부드러운 스크롤이 시작될 틈보다 넉넉해야 한다. */
const SETTLE_MS = 150;

/**
 * 사진이 없는 글에 깔 배경 — **차분한 어두운 한랭색만** 씁니다.
 *
 * 처음엔 게임 이름 해시를 색상환 전체(0~359°)에 뿌렸는데, 형광 초록·붉은색이 나와
 * 앱의 어두운 남색 톤과 따로 놀았습니다. 배경은 제목을 받쳐 주는 바닥이지 그
 * 자체가 주인공이 아니라, 고를 수 있는 폭을 좁혀 두는 쪽이 맞습니다.
 *
 * 같은 게임이 늘 같은 배경을 받도록 이름 해시로 고릅니다 — 새로고침마다 색이
 * 바뀌면 글이 바뀐 것처럼 보입니다.
 */
const SLATES = [
  ['#111a2e', '#1d3357', '#2b4a74'], // 네이비
  ['#101c26', '#1b3a4a', '#28566a'], // 딥 틸
  ['#161428', '#292350', '#3b356e'], // 인디고
  ['#141a1c', '#24383c', '#345054'], // 슬레이트 그린
] as const;

function slateOf(seed: string): readonly [string, string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return SLATES[h % SLATES.length] as unknown as readonly [string, string, string];
}

function backgroundOf(p: PostSummary): string {
  const img = p.thumbnail && p.thumbnail.mime.startsWith('image/') ? p.thumbnail.url : null;
  // 사진 위에 흰 글씨를 얹으므로 어두운 막을 한 겹 깝니다 — 밝은 사진에서 제목이 사라집니다.
  if (img) {
    return `linear-gradient(90deg, rgba(8,12,20,.82) 0%, rgba(8,12,20,.45) 55%, rgba(8,12,20,.2) 100%), url(${img}) center/cover no-repeat`;
  }
  const [a, b, c] = slateOf(p.machineShortName ?? p.categoryLabel);
  return `linear-gradient(105deg, ${a} 0%, ${b} 58%, ${c} 100%)`;
}

/** 슬라이드 한 장의 내용. 맨 뒤 사본은 링크 없이(clone) 그립니다 — 같은 글이 두 번 잡히면 안 됩니다. */
function SlideBody({ post, clone }: { post: PostSummary; clone?: boolean }) {
  return (
    <div className="news-hero-body">
      <p className="news-hero-kicker">
        {post.machineShortName && <span className="badge">{post.machineShortName}</span>}
        <span className={`cat cat-${post.category}`}>{post.categoryLabel}</span>
      </p>
      <h3 className="news-hero-title">
        {clone ? post.title : <Link href={`/community?post=${post.id}`}>{post.title}</Link>}
      </h3>
      {post.excerpt && <p className="news-hero-excerpt">{post.excerpt}</p>}
    </div>
  );
}

export default function NewsHero({ posts }: { posts: PostSummary[] }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 현재 칸을 ref 로도 들고 있습니다. 화살표·자동 넘김이 state 를 읽으면 칸이 바뀔
   * 때마다 콜백 정체가 달라지고, 그러면 자동 넘김 interval 이 매번 지워졌다 새로
   * 걸려 **영영 발화하지 않습니다**.
   */
  const indexRef = useRef(0);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const headingId = useId();

  const total = posts.length;
  const looping = total > 1;

  /**
   * ⚠ 배경 style 객체를 **반드시 고정**해야 합니다.
   *
   * 매 렌더마다 `style={{ background: ... }}` 를 새로 만들면 React 가 값이 같아도
   * style 속성을 다시 씁니다. 그런데 이 칸들은 `scroll-snap-align` 을 가진 스냅
   * 대상이라, 속성이 다시 쓰이면 브라우저가 스냅을 다시 계산하며 스크롤을 보정합니다.
   * 스크롤 → onScroll → setIndex → 리렌더 → style 재기록 → 스냅 보정 → 다시 스크롤
   * 이 되먹임이 돌아서, 넘기기가 목표까지 못 가고 88px·178px 처럼 **기어가다 멈췄습니다.**
   */
  const backgrounds = useMemo(() => posts.map(backgroundOf), [posts]);

  /**
   * 칸 번호로 스크롤. `total` 은 맨 뒤 사본을 가리킨다.
   *
   * ⚠ 즉시 이동은 `'auto'` 가 아니라 **`'instant'`** 입니다. CSSOM 에서 `'auto'` 는
   *   "즉시" 가 아니라 "이 요소의 CSS `scroll-behavior` 를 따르라" 는 뜻인데, 이
   *   트랙은 CSS 가 `smooth` 라 그대로 애니메이션됩니다. 그래서 사본에서 0번으로
   *   **소리 없이** 바꿔치기해야 할 자리가 오른쪽으로 되감기는 모션으로 보였습니다.
   */
  const scrollToSlide = useCallback((i: number, smooth = true) => {
    const track = trackRef.current;
    if (!track) return;
    const slide = track.children[i] as HTMLElement | undefined;
    if (slide) track.scrollTo({ left: slide.offsetLeft, behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  const next = useCallback(() => {
    const cur = indexRef.current;
    // 마지막이면 사본(total)으로 — 방향을 바꾸지 않고 왼쪽으로 계속 간다.
    scrollToSlide(looping ? cur + 1 : Math.min(cur + 1, total - 1));
  }, [looping, scrollToSlide, total]);

  const prev = useCallback(() => {
    const cur = indexRef.current;
    if (cur > 0) {
      scrollToSlide(cur - 1);
      return;
    }
    if (!looping) return;
    // 0번에서 '이전' — 사본으로 소리 없이 옮긴 뒤(화면은 그대로 0번이다) 마지막으로 되돌아간다.
    scrollToSlide(total, false);
    requestAnimationFrame(() => scrollToSlide(total - 1));
  }, [looping, scrollToSlide, total]);

  /**
   * 스크롤이 멈춘 자리로 현재 칸을 정한다 — 손가락이든 화살표든 같은 경로를 지난다.
   * 멎은 자리가 사본이면 애니메이션 없이 진짜 0번으로 바꿔치기한다.
   */
  const onScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const raw = Math.round(track.scrollLeft / track.clientWidth);
    const logical = total === 0 ? 0 : raw % total;
    indexRef.current = logical;
    setIndex(logical);

    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      if (looping && raw === total) scrollToSlide(0, false);
    }, SETTLE_MS);
  }, [looping, scrollToSlide, total]);

  useEffect(
    () => () => {
      if (settleRef.current) clearTimeout(settleRef.current);
    },
    [],
  );

  /**
   * 자동 넘김. 멈추는 조건이 셋입니다 — 마우스가 올라와 있을 때, 포커스가 안에
   * 있을 때(키보드로 읽는 중), 그리고 사용자가 모션을 줄이기로 했을 때. 읽는
   * 도중에 화면이 움직이면 읽던 자리를 잃습니다.
   */
  useEffect(() => {
    if (!looping || paused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(next, AUTO_MS);
    return () => clearInterval(t);
  }, [looping, paused, next]);

  if (total === 0) return null;

  return (
    <section
      className="news-hero"
      aria-roledescription="캐러셀"
      aria-labelledby={headingId}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <h2 id={headingId} className="sr-only">
        최신 소식
      </h2>

      <div className="news-hero-track" ref={trackRef} onScroll={onScroll}>
        {posts.map((p, i) => (
          <article
            className="news-hero-slide"
            key={p.id}
            style={{ background: backgrounds[i] }}
            aria-roledescription="슬라이드"
            aria-label={`${i + 1} / ${total}`}
          >
            <SlideBody post={p} />
          </article>
        ))}
        {/* 맨 뒤 사본 — 마지막에서 처음으로 이어 가기 위한 자리다. 보조기술에는 같은
            글이 두 번 있는 것으로 보이면 안 되므로 숨긴다. */}
        {looping && (
          <article
            className="news-hero-slide"
            aria-hidden="true"
            style={{ background: backgrounds[0] }}
          >
            <SlideBody post={posts[0]} clone />
          </article>
        )}
      </div>

      {looping && (
        <>
          {/*
            화살표는 **마우스에만** 보입니다. 손가락은 밀면 그만이고 화면도 좁은데,
            폰에서 제목 위에 단추 두 개가 겹치면 읽기만 나빠집니다. 반대로 마우스에는
            가로로 미는 손쉬운 방법이 없어 화살표가 안내이자 유일한 조작 수단입니다
            (components/ScrollStrip.tsx 가 같은 이유로 같은 선택을 합니다).
          */}
          <button type="button" className="news-hero-arrow is-prev" onClick={prev} aria-label="이전 소식">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M15 5 8 12l7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="news-hero-arrow is-next" onClick={next} aria-label="다음 소식">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="m9 5 7 7-7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <div className="news-hero-dots" role="tablist" aria-label="소식 넘기기">
            {posts.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`${i + 1}번째 소식`}
                className={i === index ? 'is-on' : undefined}
                onClick={() => scrollToSlide(i)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
