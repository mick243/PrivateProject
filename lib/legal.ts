/**
 * 법적 고지에 들어가는 운영자 정보 — 전부 env 에서 옵니다.
 *
 * 코드에 이름·이메일을 박지 않는 이유: 이 저장소는 공개될 수 있고, 운영자가
 * 바뀌면 배포 없이 값만 바꿔야 합니다. 값이 없으면 화면에 **자리표시자가 그대로
 * 보이도록** 둡니다 — 조용히 숨기면 빠진 채로 출시됩니다.
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
