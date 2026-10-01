'use client';

import { useRef, type KeyboardEvent } from 'react';

/**
 * 검색창의 엔터 — 모바일 키보드의 입력(⏎) · 검색 키 — 를 **"지금 검색 + 키보드 내리기"** 로.
 *
 * 2026-10-01 "모바일에서 글을 치고 입력 키를 눌러도 검색이 안 된다" 의 원인이 셋이라
 * 검색창마다 따로 고치지 않고 여기 한 곳에 둡니다 (파인더 · 커뮤니티 · 제보 피드).
 *
 * 1. **눌러도 화면이 그대로다.** 목록 검색은 칠 때마다 300ms 뒤 조회하므로(디바운스),
 *    엔터를 누를 즈음에는 이미 조회가 끝나 있어 바뀌는 게 없고, 키보드는 결과를 가린 채
 *    남는다. 엔터는 "다 쳤다" 는 뜻이니 터치 화면에서는 입력칸에서 포커스를 빼 키보드를
 *    내린다. 마우스 화면에서는 이어서 고쳐 칠 수 있게 포커스를 둔다.
 * 2. **한글 조합 중의 엔터.** 마지막 글자를 조합하는 중에 누른 엔터는 IME 가 글자를
 *    확정하는 데 쓰고, 그 keydown 은 isComposing(또는 keyCode 229)으로 온다 — form 의
 *    암묵 제출이 그 키를 건너뛰는 환경이 있다. 그래서 조합 중 엔터는 조합이 끝난
 *    직후(compositionend)에 처리하고, 값은 state 가 아니라 **입력칸에서 바로** 읽는다
 *    (확정된 마지막 글자가 아직 state 에 없을 수 있다).
 * 3. **키 모양.** enterKeyHint="search" 로 키보드의 그 키를 '검색' 으로 바꿔 달라고 알린다.
 *
 * 쓰는 법: `const { inputProps, submit } = useSearchEnter(v => …)` →
 * `<input {...inputProps} …>` · form 이면 `onSubmit={e => { e.preventDefault(); submit(); }}`.
 * 엔터는 여기서 preventDefault 하므로 form 의 암묵 제출과 두 번 돌지 않는다 —
 * form 의 onSubmit 은 검색 버튼을 누를 때만 불린다.
 */
export function useSearchEnter(onSearch: (value: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  /** 조합 중에 엔터가 눌렸다 — 조합이 끝나면 검색한다 */
  const enterWhileComposing = useRef(false);
  const last = useRef({ at: 0, value: '' });

  const submit = () => {
    const el = ref.current;
    if (!el) return;
    // 엔터 한 번이 두 번 오는 환경이 있다 — 맥 한글 입력기는 조합 중 keydown 뒤에
    // 확정된 Enter 를 또 보낸다. 파인더는 매번 지역 검색 API 를 부르므로 거른다.
    const now = performance.now();
    if (el.value === last.current.value && now - last.current.at < 150) return;
    last.current = { at: now, value: el.value };
    onSearch(el.value);
    if (window.matchMedia('(pointer: coarse)').matches) el.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 안드로이드 키보드는 조합 중 모든 키를 key 'Unidentified' · 229 로 보낸다 — 그때의
    // 엔터는 여기서 못 알아보지만, 글자를 확정한 뒤 진짜 Enter(13)를 한 번 더 보낸다.
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      enterWhileComposing.current = e.key === 'Enter';
      return;
    }
    enterWhileComposing.current = false;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  };

  const onCompositionEnd = () => {
    if (!enterWhileComposing.current) return;
    enterWhileComposing.current = false;
    submit();
  };

  return {
    submit,
    inputProps: { ref, enterKeyHint: 'search' as const, onKeyDown, onCompositionEnd },
  };
}
