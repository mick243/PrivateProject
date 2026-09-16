/**
 * 색 테마 — 시스템 설정 / 라이트 / 다크.
 *
 * 실제 색은 `app/globals.css` 의 토큰이 정하고, 여기서는 **어느 쪽을 켤지**만
 * 다룹니다. 켜는 방법은 `<html data-theme="light|dark">` 한 곳입니다.
 *
 * 화면과 첫 페인트 전에 도는 스크립트가 같은 규칙을 봐야 하므로 규칙을 여기 모읍니다 —
 * 두 곳에 따로 적으면 새로고침할 때만 잠깐 다른 테마가 보이는 식으로 어긋납니다.
 */

/** 사용자가 고를 수 있는 값. 'system' 은 고르지 **않은** 상태이기도 합니다 */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** 실제로 화면에 입혀지는 두 가지 */
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'arcade-theme';

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: '시스템 설정',
  light: '라이트',
  dark: '다크',
};

/** 버튼에 그리는 글자. 이모지가 아니라 글꼴에 있는 기호라 플랫폼마다 모양이 튀지 않습니다 */
export const THEME_GLYPHS: Record<ThemeChoice, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

/** 누르면 다음 값 — 시스템 → 라이트 → 다크 → 시스템 */
export const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

export function nextChoice(current: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
}

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || v === 'light' || v === 'dark';
}

/**
 * 첫 페인트 **전에** `<html>` 에 테마를 입히는 스크립트.
 *
 * 이게 없으면 다크를 고른 사람이 새로고침할 때마다 흰 화면이 한 번 번쩍입니다 — CSS 는
 * 기본이 다크지만 OS 가 라이트면 `prefers-color-scheme` 규칙이 먼저 먹고, 그 뒤에
 * React 가 붙으면서 다크로 바뀌기 때문입니다. 그래서 번들이 아니라 문서 안에 인라인으로
 * 넣어 **동기적으로** 돌립니다.
 *
 * 통째로 try/catch 인 이유: localStorage 는 있는데 못 읽는 환경이 있습니다
 * (사파리 사생활 보호 모드 · 쿠키 차단). 거기서 던지면 이 스크립트가 멈춰 페이지가
 * 테마 없이 뜨는 게 아니라, 던진 지점 이후가 통째로 날아갑니다.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
if(c!=='light'&&c!=='dark'){c=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
document.documentElement.setAttribute('data-theme',c);
}catch(e){}})();`;
