'use client';

import { useEffect, useState } from 'react';
import {
  isThemeChoice,
  nextChoice,
  THEME_GLYPHS,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from '@/lib/theme';

/**
 * 색 테마 전환 — 시스템 설정 / 라이트 / 다크를 돌아가며 고릅니다.
 *
 * '시스템 설정' 을 지우지 않은 이유: 낮과 밤에 OS 를 따라 바뀌기를 바라는 사람이
 * 있고, 그건 라이트·다크 둘 중 하나를 박아 두는 것으로는 표현할 수 없습니다.
 * 그 상태는 저장소에서 **키를 지워** 나타냅니다 — 'system' 이라는 문자열을 넣어 두면
 * 나중에 기본값을 바꿀 때 "고른 적 없음" 과 "시스템을 고름" 을 구분할 수 없습니다.
 */
export default function ThemeToggle() {
  /**
   * 서버에서는 어느 쪽인지 알 수 없습니다 (저장소도 OS 설정도 브라우저에 있습니다).
   * 그래서 첫 렌더는 양쪽이 같은 'system' 으로 그리고, 마운트된 뒤에 실제 값으로
   * 맞춥니다 — 서버 HTML 과 다른 값을 첫 렌더에 넣으면 하이드레이션이 어긋납니다.
   *
   * 화면 색 자체는 이 컴포넌트를 기다리지 않습니다. 첫 페인트 전에 도는 인라인
   * 스크립트가 이미 <html> 에 입혀 뒀습니다 (lib/theme.ts THEME_INIT_SCRIPT).
   */
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemeChoice(saved)) setChoice(saved);
    } catch {
      // 저장소를 못 읽는 환경 — 시스템 설정으로 두면 된다 (lib/theme.ts 참고)
    }
    setReady(true);
  }, []);

  /**
   * '시스템 설정' 인 동안에는 OS 가 바뀌는 것을 따라갑니다.
   *
   * CSS 의 `prefers-color-scheme` 만으로는 부족합니다 — 인라인 스크립트가 이미
   * `data-theme` 을 박아 뒀고, 그게 media 규칙을 이기기 때문입니다. 그 값을 여기서
   * 다시 써 주지 않으면 해가 진 뒤에도 낮에 켠 라이트가 그대로 남습니다.
   */
  useEffect(() => {
    const apply = (light: boolean) =>
      document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');

    if (choice !== 'system') {
      apply(choice === 'light');
      return;
    }

    const mq = matchMedia('(prefers-color-scheme: light)');
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 저장만 실패한다 — 이번 방문 동안은 위 effect 가 화면에 입혀 준다
    }
  };

  const label = `색 테마: ${THEME_LABELS[choice]}`;

  return (
    <button
      type="button"
      className="theme-toggle"
      // 지금 무엇인지와 누르면 무엇이 되는지를 함께 말해 준다 — 기호만으로는
      // '◐' 가 시스템 설정이라는 걸 알 수 없다.
      title={`${label} (누르면 ${THEME_LABELS[nextChoice(choice)]})`}
      aria-label={label}
      onClick={() => pick(nextChoice(choice))}
    >
      {/* 값을 읽기 전에는 기호가 한 번 바뀌어 보일 수 있으므로 자리만 잡아 둔다 */}
      <span aria-hidden="true">{ready ? THEME_GLYPHS[choice] : ''}</span>
    </button>
  );
}
