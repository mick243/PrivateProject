/**
 * 법적 고지에 들어가는 운영자 정보 — 전부 env 에서 옵니다.
 *
 * 코드에 이름·이메일을 박지 않는 이유: 이 저장소는 공개될 수 있고, 운영자가
 * 바뀌면 배포 없이 값만 바꿔야 합니다. 값이 없으면 화면에 **자리표시자가 그대로
 * 보이도록** 둡니다 — 조용히 숨기면 빠진 채로 출시됩니다. 다만 운영 빌드가 빈 값으로 나가지
 * 않게 배포 묶음 만들기(deploy/ncp/build-release.sh)와 서버 기동(lib/env-check.ts)이 막습니다.
 * NEXT_PUBLIC_* 은 **빌드 때** 코드에 박히므로(서버 쪽도 마찬가지) 기동 검사는 이 파일의
 * LEGAL_PLACEHOLDERS_PRESENT 를 봅니다 — 서버의 실행 환경(server.env)에는 이 값이 없는 것이 정상입니다.
 *
 * NEXT_PUBLIC_ 인 이유: 약관 페이지는 서버 컴포넌트지만 가입 폼(클라이언트)에서도
 * 문의 주소를 보여 줍니다.
 */
export const OPERATOR_NAME = process.env.NEXT_PUBLIC_OPERATOR_NAME?.trim() || '[운영자명 — NEXT_PUBLIC_OPERATOR_NAME]';
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || '[문의 이메일 — NEXT_PUBLIC_CONTACT_EMAIL]';
export const LEGAL_EFFECTIVE_DATE = process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE?.trim() || '2026-09-13';

/** env 가 비어 자리표시자가 보이는 상태인가 — 출시 체크리스트가 봅니다 */
export const LEGAL_PLACEHOLDERS_PRESENT = OPERATOR_NAME.startsWith('[') || CONTACT_EMAIL.startsWith('[');

export const mailto = (subject: string) =>
  CONTACT_EMAIL.startsWith('[') ? '#' : `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

/**
 * 약관 화면의 빨간 설정 안내("NEXT_PUBLIC_… 을 채우세요")를 그릴지 — **개발 모드에서만**.
 * 운영 화면에 설정 키 이름을 내지 않습니다 (docs/DESIGN-GUIDE.md §6 · 2026-11-20 UX 시험 C-12).
 * 운영에서 값이 비는 것은 화면이 아니라 배포 · 기동 단계가 막습니다
 * (deploy/ncp/build-release.sh · lib/env-check.ts enforceProductionEnv).
 */
export const SHOW_LEGAL_DEV_WARNING = LEGAL_PLACEHOLDERS_PRESENT && process.env.NODE_ENV !== 'production';
