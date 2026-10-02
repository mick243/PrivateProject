import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEmailMaskingOn, maskEmail } from '@/lib/email-mask';

/**
 * 이메일 가려서 저장하기 — **DB 로 나가는 값에 실제 주소가 없는가** (lib/email-mask.ts).
 *
 * 못 박아 두는 것:
 *   1. 가리는 모양 — 앞 두 글자 + `*` · 도메인은 그대로
 *   2. 일반 가입 · 소셜 로그인 둘 다 가린 값만 DB 에 쓴다
 *   3. 가린 값으로 "이미 가입된 이메일" 을 막지 않는다 — 같은 모양의 다른 사람이 많다
 *   4. 가리는 동안에는 확인 메일을 보내지도, 토큰을 만들지도 않는다
 *
 * DB 는 대역입니다 — 확인하려는 것은 SQL 이 아니라 **쓰려는 값**입니다.
 */

type PlayerRow = { nickname: string; email: string | null; email_verified_at: Date | null };

const db = {
  /** players.findMany 가 돌려줄 기존 줄 (중복 검사 대상) */
  existing: [] as PlayerRow[],
  findManyWhere: [] as unknown[],
  createdPlayers: [] as Record<string, unknown>[],
  identities: [] as Record<string, unknown>[],
  verificationWrites: 0,
};

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({
    players: {
      findMany: async ({ where }: { where: unknown }) => {
        db.findManyWhere.push(where);
        return db.existing;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.createdPlayers.push(data);
        return { id: 7 };
      },
      findUnique: async () => ({ email: 'pu*****@example.com', email_verified_at: null }),
    },
    player_identities: {
      findUnique: async () => null,
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        db.identities.push(...data);
        return { count: data.length };
      },
    },
    email_verifications: {
      create: async () => {
        db.verificationWrites++;
        return {};
      },
    },
    $transaction: async () => {
      db.verificationWrites++;
    },
  }),
  TX_OPTIONS: {},
}));

const sent: unknown[] = [];
vi.mock('@/lib/mailer', () => ({
  isMailConfigured: () => true,
  sendMail: async (mail: unknown) => {
    sent.push(mail);
    return true;
  },
}));

const { createAccount, linkOAuthAccount } = await import('@/lib/auth');
const { sendVerificationMail } = await import('@/lib/email-verify');

beforeEach(() => {
  db.existing = [];
  db.findManyWhere = [];
  db.createdPlayers = [];
  db.identities = [];
  db.verificationWrites = 0;
  sent.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('maskEmail — @ 앞을 가리는 모양', () => {
  it('앞 두 글자만 남기고 나머지는 같은 개수의 * 로', () => {
    expect(maskEmail('pumpfan@example.com')).toBe('pu*****@example.com');
    expect(maskEmail('abcd@example.com')).toBe('ab**@example.com');
  });

  it('세 글자 이하면 한 글자만 — 두 글자를 남기면 거의 다 보인다', () => {
    expect(maskEmail('abc@example.com')).toBe('a**@example.com');
    expect(maskEmail('ab@example.com')).toBe('a*@example.com');
  });

  it('한 글자짜리는 그 글자도 가린다', () => {
    expect(maskEmail('a@example.com')).toBe('*@example.com');
  });

  it('도메인은 그대로, @ 는 마지막 것을 기준으로', () => {
    expect(maskEmail('"a@b"@example.com')).toBe('"a***@example.com');
  });

  it('국제화 주소의 한글이 반으로 잘리지 않는다 (코드 포인트로 센다)', () => {
    expect(maskEmail('오락실매니아@example.com')).toBe('오락****@example.com');
  });

  it('두 번 가려도 같은 값 — 이미 가린 주소가 다시 들어와도 모양이 변하지 않는다', () => {
    const once = maskEmail('pumpfan@example.com');
    expect(maskEmail(once)).toBe(once);
  });
});

describe('isEmailMaskingOn — 켜고 끄는 스위치', () => {
  it('비워 두면 운영에서만 켜진다', () => {
    expect(isEmailMaskingOn({ NODE_ENV: 'production' })).toBe(true);
    expect(isEmailMaskingOn({ NODE_ENV: 'development' })).toBe(false);
    expect(isEmailMaskingOn({ NODE_ENV: 'test' })).toBe(false);
  });

  it('EMAIL_MASKING 이 있으면 그 값이 이긴다', () => {
    expect(isEmailMaskingOn({ NODE_ENV: 'production', EMAIL_MASKING: 'off' })).toBe(false);
    expect(isEmailMaskingOn({ NODE_ENV: 'development', EMAIL_MASKING: 'on' })).toBe(true);
    expect(isEmailMaskingOn({ NODE_ENV: 'production', EMAIL_MASKING: ' OFF ' })).toBe(false);
  });
});

describe('일반 가입 — players.email 에 들어가는 값', () => {
  it('켜져 있으면 가린 값만 쓴다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    const r = await createAccount('펌프장인', 'password-1234', 'pumpfan@example.com');
    expect(r.ok).toBe(true);
    expect(db.createdPlayers[0].email).toBe('pu*****@example.com');
    expect(JSON.stringify(db.createdPlayers)).not.toContain('pumpfan');
  });

  it('켜져 있으면 이메일로 중복을 묻지도 막지도 않는다 — 같은 모양의 다른 사람이 많다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    db.existing = [
      { nickname: '다른사람', email: 'pu*****@example.com', email_verified_at: new Date() },
    ];
    const r = await createAccount('펌프장인', 'password-1234', 'pumpman@example.com');
    expect(r.ok).toBe(true);
    // 중복 검사 조건에 이메일이 실리지 않는다 — 실제 주소가 조회문으로도 나가지 않게
    expect(JSON.stringify(db.findManyWhere)).not.toContain('email');
  });

  it('꺼져 있으면 적은 그대로 쓰고, 확인된 같은 주소는 막는다 (원래 동작)', async () => {
    vi.stubEnv('EMAIL_MASKING', 'off');
    db.existing = [
      { nickname: '다른사람', email: 'pumpfan@example.com', email_verified_at: new Date() },
    ];
    const blocked = await createAccount('펌프장인', 'password-1234', 'pumpfan@example.com');
    expect(blocked).toEqual({ ok: false, reason: 'email-taken' });

    db.existing = [];
    const r = await createAccount('펌프장인', 'password-1234', 'pumpfan@example.com');
    expect(r.ok).toBe(true);
    expect(db.createdPlayers[0].email).toBe('pumpfan@example.com');
  });

  it('닉네임 중복은 가리는 것과 상관없이 막는다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    db.existing = [{ nickname: '펌프장인', email: null, email_verified_at: null }];
    const r = await createAccount('펌프장인', 'password-1234', 'pumpfan@example.com');
    expect(r).toEqual({ ok: false, reason: 'taken' });
  });
});

describe('소셜 로그인 — player_identities.email 에 들어가는 값', () => {
  const profile = { provider: 'google', providerUid: 'g-123', nickname: '구글사람' };

  it('켜져 있으면 가린 값만 쓴다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    await linkOAuthAccount({ ...profile, email: 'pumpfan@example.com' });
    expect(db.identities[0].email).toBe('pu*****@example.com');
    expect(JSON.stringify(db.identities)).not.toContain('pumpfan');
  });

  it('제공자가 이메일을 주지 않으면 비운 채로 둔다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    await linkOAuthAccount({ ...profile, email: null });
    expect(db.identities[0].email).toBeNull();
  });

  it('꺼져 있으면 받은 그대로 쓴다 (원래 동작)', async () => {
    vi.stubEnv('EMAIL_MASKING', 'off');
    await linkOAuthAccount({ ...profile, email: 'pumpfan@example.com' });
    expect(db.identities[0].email).toBe('pumpfan@example.com');
  });
});

describe('확인 메일 — 가리는 동안에는 보낼 곳이 없다', () => {
  it('보내지도, 토큰을 만들지도 않는다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    const r = await sendVerificationMail(7, 'https://arcade.example.com');
    expect(r).toEqual({ ok: false, reason: 'masked' });
    expect(sent).toHaveLength(0);
    expect(db.verificationWrites).toBe(0);
  });
});
