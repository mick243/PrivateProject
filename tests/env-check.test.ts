import { describe, expect, it } from 'vitest';
import { checkProductionEnv } from '@/lib/env-check';

/**
 * 운영 필수 설정 검사 — **무엇이 빠졌을 때 기동을 막는가**를 고정합니다.
 *
 * 이 목록은 QA 에서 "요청 시점에야 드러났던" 것들입니다. 항목을 빼면 그 사고가
 * 조용히 돌아오므로, 하나씩 빠졌을 때 오류가 나는지 봅니다.
 */

const good = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://u:p@db:5432/arcade',
  ADMIN_PASSWORD: 'correct horse battery staple',
  APP_URL: 'https://arcade.example.com',
  TRUSTED_PROXY_HOPS: '1',
  NEXT_PUBLIC_NAVER_MAP_KEY_ID: 'key',
  GEMINI_API_KEY: 'gk',
} satisfies Record<string, string>;

describe('checkProductionEnv', () => {
  it('개발·테스트에서는 아무것도 요구하지 않는다', () => {
    expect(checkProductionEnv({ NODE_ENV: 'test' })).toEqual({ errors: [], warnings: [] });
    expect(checkProductionEnv({})).toEqual({ errors: [], warnings: [] });
  });

  it('필수값이 다 있으면 오류가 없다', () => {
    expect(checkProductionEnv(good).errors).toEqual([]);
  });

  it.each([
    ['AUTH_SECRET', 'AUTH_SECRET'],
    ['DATABASE_URL', 'DATABASE_URL'],
    ['ADMIN_PASSWORD', 'ADMIN_PASSWORD'],
    ['APP_URL', 'APP_URL'],
    ['TRUSTED_PROXY_HOPS', 'TRUSTED_PROXY_HOPS'],
  ])('%s 가 없으면 기동을 막는다', (key, mentioned) => {
    const env = { ...good } as Record<string, string | undefined>;
    delete env[key];
    const { errors } = checkProductionEnv(env);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(mentioned);
  });

  it('AUTH_SECRET 이 짧으면 없는 것과 같다', () => {
    expect(checkProductionEnv({ ...good, AUTH_SECRET: 'short' }).errors[0]).toContain('AUTH_SECRET');
  });

  it('TRUSTED_PROXY_HOPS=0 은 프록시가 없다는 뜻이라 막는다', () => {
    expect(checkProductionEnv({ ...good, TRUSTED_PROXY_HOPS: '0' }).errors[0]).toContain('TRUSTED_PROXY_HOPS');
  });

  it('APP_URL 이 URL 이 아니면 막고, http 면 경고만 한다', () => {
    expect(checkProductionEnv({ ...good, APP_URL: 'not a url' }).errors[0]).toContain('APP_URL');
    const http = checkProductionEnv({ ...good, APP_URL: 'http://arcade.example.com' });
    expect(http.errors).toEqual([]);
    expect(http.warnings.some((w) => w.includes('https'))).toBe(true);
  });

  it('DB_FALLBACK 을 켜 두면 경고한다 — 운영 기본은 off', () => {
    expect(checkProductionEnv({ ...good, DB_FALLBACK: 'on' }).warnings.some((w) => w.includes('DB_FALLBACK'))).toBe(true);
    expect(checkProductionEnv({ ...good, DB_FALLBACK: 'off' }).warnings.some((w) => w.includes('DB_FALLBACK'))).toBe(false);
  });

  it('지도 키·Gemini 키는 없어도 뜬다 (경고)', () => {
    const { errors, warnings } = checkProductionEnv({
      ...good,
      NEXT_PUBLIC_NAVER_MAP_KEY_ID: undefined,
      GEMINI_API_KEY: undefined,
    });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
  });
});
