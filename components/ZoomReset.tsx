'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * 경로가 바뀐 뒤 이만큼 기다렸다 겁니다. Next 는 화면을 옮길 때 head 의 viewport 태그를 지웠다가
 * 다시 꽂습니다(개발 서버 실측: 주소가 바뀌는 순간 사라지고 11ms 뒤 돌아옴). 그 사이에 찾으면
 * 태그가 없거나, 곧 버려질 옛 태그를 고치게 됩니다.
 */
const SETTLE_MS = 150;
/** maximum-scale 을 잠깐 넣어 두는 시간 — Safari 가 새 값을 읽고 배율을 1로 맞출 틈 */
const CLAMP_MS = 300;

const viewportMeta = () => document.querySelector<HTMLMetaElement>('meta[name="viewport"]');

/**
 * 화면을 옮기면 확대를 1배로 되돌립니다 — 새 페이지를 불러올 때와 같게.
 *
 * 2026-10-02 "로그인하고 비밀번호 저장 팝업이 뜨면 화면이 확대된 채로 고정된다". 원인은 두 겹입니다.
 *   1. iOS Safari 는 글자가 16px 보다 작은 칸을 누르면 화면을 확대하고, 칸에서 나가도 **풀지 않습니다.**
 *      확대 자체를 막는 것은 칸 글자 크기의 몫입니다(손가락 화면에서 16px 이상) — 여기는 그래도
 *      확대된 경우(16px 아래로 남은 칸 · 사용자가 벌린 확대)의 뒷수습입니다.
 *   2. 로그인 · 가입은 끝나면 `router.replace` 로 화면만 바꿉니다. 문서를 새로 읽지 않으니 브라우저가
 *      배율을 처음으로 돌려놓을 기회가 없어 다음 화면까지 확대된 채로 갑니다. 비밀번호 저장 팝업은 그
 *      순간에 같이 뜰 뿐입니다.
 * 그래서 경로가 바뀔 때 확대돼 있으면 viewport 에 `maximum-scale=1` 을 잠깐 넣어 Safari 가 배율을
 * 1로 맞추게 하고, 곧바로 원래 값으로 돌립니다. 계속 걸어 두면 손가락으로 벌려 보는 확대까지 막혀
 * 저시력 사용자가 못 씁니다 — 그래서 "잠깐" 입니다.
 *
 * 같은 화면 안에서는 건드리지 않습니다 — 일부러 벌려 보고 있는 사람의 확대를 빼앗지 않게.
 * 첫 렌더도 건너뜁니다 (문서를 막 읽은 참이라 배율이 이미 처음 값입니다).
 */
export default function ZoomReset() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const vv = window.visualViewport;
    if (!vv || vv.scale <= 1.01) return;

    let original: string | null = null;
    // 되돌릴 때도 그때 head 에 있는 태그를 다시 찾습니다 — 그 사이 Next 가 갈아 끼웠다면
    // 새 태그는 이미 원래 값이라 할 일이 없습니다.
    const restore = () => {
      const meta = viewportMeta();
      if (meta && original !== null && meta.content !== original) meta.content = original;
      original = null;
    };
    const clamp = window.setTimeout(() => {
      const meta = viewportMeta();
      if (!meta || /maximum-scale/.test(meta.content)) return;
      original = meta.content;
      meta.content = `${original}, maximum-scale=1`;
    }, SETTLE_MS);
    const release = window.setTimeout(restore, SETTLE_MS + CLAMP_MS);
    return () => {
      window.clearTimeout(clamp);
      window.clearTimeout(release);
      restore();
    };
  }, [pathname]);

  return null;
}
