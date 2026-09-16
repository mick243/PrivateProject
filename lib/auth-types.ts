/**
 * 세션 관련 타입 — **클라이언트에서도 import 합니다**.
 *
 * lib/auth.ts 는 node:crypto 와 getDb() 를 끌고 오므로 컴포넌트에서 못 씁니다.
 * 서버·클라이언트가 함께 봐야 하는 모양만 여기 둡니다 (*-types.ts 규칙).
 */

/** 로그인한 사람. 지금은 관리자만 로그인합니다 */
export interface SessionUser {
  /** players.id — 관리자도 제보·리뷰를 남기는 한 명의 플레이어입니다 */
  playerId: number;
  nickname: string;
  isAdmin: boolean;
}

/** 세션 쿠키 이름. 미들웨어나 테스트에서도 같은 값을 봐야 합니다 */
export const SESSION_COOKIE = 'arcade_session';

/**
 * 관리자 권한 뱃지에 찍히는 말.
 *
 * 상단 네비(PlayerPicker)와 로그인 화면(LoginForm)이 같은 뱃지를 그리므로 한
 * 곳에 둡니다. 기본 관리자 닉네임도 이 값이라(ADMIN_NICKNAME 기본값) 이름과
 * 뱃지가 '관리자 관리자' 로 겹쳐 보이는데, 뜻이 다른 두 칸입니다 —
 * 앞은 활동 이름, 뒤는 권한.
 */
export const ADMIN_LABEL = '관리자';

/**
 * 가입 시 비밀번호 최소 길이.
 *
 * 판정은 서버(lib/validation.ts signupInputSchema)가 하지만 가입 화면도 같은
 * 값을 적어야 합니다. lib/validation.ts 를 컴포넌트에서 import 하면 zod 가
 * 통째로 클라이언트 번들에 따라 들어와서, 숫자 하나만 여기 둡니다.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 로그인·가입이 끝나고 돌아갈 곳을 **앱 안쪽 경로로만** 좁힙니다.
 *
 * `?next=` 는 주소창에서 누구나 고칠 수 있습니다. 그대로 믿고 이동하면
 * `/login?next=https://…` 한 줄로 우리 도메인에서 남의 사이트로 튕겨 보내는
 * 링크가 됩니다(오픈 리다이렉트).
 *
 * 화면(로그인 폼)과 서버(OAuth 콜백)가 같은 판단을 해야 해서 여기 둡니다 —
 * 한쪽만 고치면 다른 쪽이 그대로 뚫린 채 남습니다.
 *
 * ─── 왜 '슬래시로 시작하는가' 로는 모자라나 ───
 * 예전 판정은 `/` 로 시작하고 `//` 가 아니면 통과였습니다. 그런데 브라우저와
 * `new URL()` 은 **역슬래시를 슬래시로 취급**합니다. 그래서
 *
 *     safeNext('/\evil.com')            → 통과 (슬래시로 시작하고 // 가 아니다)
 *     new URL('/\evil.com', 우리주소)   → https://evil.com/
 *
 * 가 되어, 카카오 로그인을 정상으로 마친 사람이 우리 도메인의 302 를 타고 남의
 * 사이트에 착지했습니다 (2026-09-13 QA 에서 재현). 문자를 하나씩 막는 대신
 * **URL 로 해석해 본 뒤 출처가 그대로인지** 봅니다 — 브라우저와 같은 파서를 쓰므로
 * 이런 표기 차이가 더 나와도 같은 답을 냅니다.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/';
  try {
    // 출처가 있는 아무 기준 주소나 — 결과가 그 출처를 벗어나면 앱 밖으로 나가는 값이다.
    const base = 'http://arcade.invalid';
    const url = new URL(raw, base);
    if (url.origin !== base) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
