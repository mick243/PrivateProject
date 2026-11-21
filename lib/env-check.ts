/**
 * 운영 필수 환경변수를 **서버가 뜰 때** 한 번에 봅니다 (instrumentation.ts 가 부릅니다).
 *
 * 2026-09-13 QA 에서 확인한 것: 빠진 값이 전부 **요청 시점**에 드러났습니다.
 *   - AUTH_SECRET 없음    → 쿠키 없는 방문자는 정상, 로그인·권한 확인만 500
 *   - ADMIN_PASSWORD 없음 → 일반 사용자 로그인까지 503 (R11)
 *   - APP_URL 없음        → 프록시 뒤에서 OAuth 콜백 주소가 내부 주소로 잡혀 토큰 교환 실패
 *   - DATABASE_URL 없음   → 시드로 만든 PGlite 로 "정상" 기동 (09-22 Prisma 이관 뒤로는 첫 DB 요청이 500)
 *   - TRUSTED_PROXY_HOPS 없음 → 가입 시도 제한이 0 (lib/auth.ts clientKey 가 null)
 * 전부 "배포는 성공했는데 누군가 로그인을 시도할 때" 알게 되는 것들입니다.
 * 뜰 때 죽는 쪽이 낫습니다 — 클러스터가 백오프로 재기동하며 로그에 이유가 남습니다.
 *
 * 순수 함수로 두고 env 객체를 인자로 받는 이유는 테스트입니다 (tests/env-check.test.ts).
 */

import { LEGAL_PLACEHOLDERS_PRESENT } from './legal';

export interface EnvCheckResult {
  /** 이것이 하나라도 있으면 기동하지 않아야 합니다 */
  errors: string[];
  /** 기동은 하되 로그에 남길 것 */
  warnings: string[];
}

const MIN_SECRET_LENGTH = 16;

/** process.env 모양 — Next 의 타입은 NODE_ENV 를 필수로 두므로 테스트가 부분 객체를 넘길 수 있게 느슨하게 받습니다 */
export type EnvLike = Record<string, string | undefined>;

/** 환경변수 밖에서 오는 판정 — 빌드 때 박힌 값처럼 env 객체로는 볼 수 없는 것 */
export interface BuildFacts {
  /**
   * 약관 · 개인정보처리방침의 운영자 이름 · 연락처가 비어 자리표시자가 보이는가 (lib/legal.ts).
   * NEXT_PUBLIC_* 은 빌드 때 박히므로 서버의 실행 env 가 아니라 빌드 결과를 봐야 합니다.
   */
  legalPlaceholders?: boolean;
}

export function checkProductionEnv(env: EnvLike = process.env, facts: BuildFacts = {}): EnvCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env.NODE_ENV !== 'production') return { errors, warnings };

  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    errors.push(
      `AUTH_SECRET 이 없거나 ${MIN_SECRET_LENGTH}자보다 짧습니다 — 세션 쿠키를 서명할 수 없어 로그인이 500 으로 끝납니다`,
    );
  }

  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL 이 없습니다 — 앱은 PostgreSQL 에만 붙습니다 (lib/prisma.ts). 첫 DB 요청부터 500 이 됩니다');
  }

  if (!env.ADMIN_PASSWORD) {
    errors.push('ADMIN_PASSWORD 가 없습니다 — /api/auth/login 이 모든 사용자에게 503 을 돌려줍니다');
  }

  if (!env.APP_URL) {
    errors.push('APP_URL 이 없습니다 — OAuth 콜백 주소를 Host 헤더로 유추하면 프록시 뒤에서 어긋납니다');
  } else {
    try {
      const url = new URL(env.APP_URL);
      if (url.protocol !== 'https:') {
        warnings.push(`APP_URL 이 https 가 아닙니다 (${url.protocol}) — 세션 쿠키가 Secure 라 http 에서는 저장되지 않습니다`);
      }
    } catch {
      errors.push(`APP_URL 이 URL 형식이 아닙니다: ${env.APP_URL}`);
    }
  }

  const hops = Number(env.TRUSTED_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 1) {
    errors.push(
      'TRUSTED_PROXY_HOPS 가 1 이상이어야 합니다 — 없으면 클라이언트 주소를 모르므로 가입·익명 제보 시도 제한이 0 입니다 (npm run start:cluster 는 자동으로 1 을 넣습니다)',
    );
  }

  // 2026-11-20 UX 시험 C-12: 약관에 '[운영자명 — …]' 이 그대로 보여 열람 · 삭제 요청을 보낼 곳이 없었습니다.
  // 법적 고지에 연락처가 없는 채로 받는 가입은 받지 않는 편이 낫습니다 — 기동하지 않습니다.
  if (facts.legalPlaceholders) {
    errors.push(
      '약관 · 개인정보처리방침의 운영자 정보가 비어 있습니다 — NEXT_PUBLIC_OPERATOR_NAME · NEXT_PUBLIC_CONTACT_EMAIL 을 deploy/ncp/build.env 에 채워 **다시 빌드**하세요 (빌드 때 박히는 값)',
    );
  }

  if (!env.RESEND_API_KEY) {
    warnings.push('RESEND_API_KEY 가 없습니다 — 확인 메일 · 비밀번호 찾기 메일이 나가지 않습니다 (비밀번호 찾기 화면은 문의 주소를 대신 보여 줍니다)');
  }

  if (env.DB_FALLBACK && env.DB_FALLBACK !== 'off') {
    warnings.push('DB_FALLBACK 이 켜져 있습니다 — Postgres 가 끊기면 인스턴스마다 다른 사본에 씁니다. 운영에서는 off 를 권합니다');
  }

  if (!env.NEXT_PUBLIC_NAVER_MAP_KEY_ID) {
    warnings.push('NEXT_PUBLIC_NAVER_MAP_KEY_ID 가 없습니다 — 지도가 FallbackMap 으로 뜹니다 (빌드 시점 값이라 재빌드가 필요합니다)');
  }

  if (!env.GEMINI_API_KEY) {
    warnings.push('GEMINI_API_KEY 가 없습니다 — 챗봇 자유 질문이 503 입니다');
  }

  return { errors, warnings };
}

/**
 * 결과를 로그로 옮기고, 오류가 있으면 프로세스를 끝냅니다.
 * `next build` 의 정적 생성 단계(NEXT_PHASE=phase-production-build)에서는 보지 않습니다 —
 * 빌드 머신에는 운영 비밀이 없는 것이 정상입니다.
 */
export function enforceProductionEnv(
  env: EnvLike = process.env,
  // 기본값은 이 빌드에 박힌 값 (lib/legal.ts — NEXT_PUBLIC_* 은 서버 번들에도 빌드 때 들어갑니다)
  facts: BuildFacts = { legalPlaceholders: LEGAL_PLACEHOLDERS_PRESENT },
): void {
  if (env.NEXT_PHASE === 'phase-production-build') return;
  // 로컬에서 운영 빌드를 잠깐 띄워 볼 때(PWA 확인 등)의 탈출구. 운영 배포에서는 절대 켜지 마세요.
  if (env.ENV_CHECK === 'off') {
    console.warn('[env] ⚠ ENV_CHECK=off — 운영 필수 설정 검사를 건너뜁니다. 실제 배포에서는 켜 두세요.');
    return;
  }
  const { errors, warnings } = checkProductionEnv(env, facts);
  for (const w of warnings) console.warn(`[env] ⚠ ${w}`);
  if (errors.length === 0) return;
  for (const e of errors) console.error(`[env] ✗ ${e}`);
  console.error(`[env] 운영 필수 설정 ${errors.length}건이 빠져 기동하지 않습니다 (.env.example 참고)`);
  process.exit(1);
}
