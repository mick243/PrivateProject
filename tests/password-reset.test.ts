import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 비밀번호 찾기 (lib/password-reset.ts · db/migrate-084) — **링크 한 장이 무엇을 여는가**.
 *
 * DB 는 대역으로 세우고 판정만 봅니다 (tests/email-verify.test.ts 와 같은 방식).
 * 못 박는 것:
 *   1. **확인된 이메일**이 있는 계정에만 메일이 간다 — 확인 전 주소는 아무나 적어 낼 수 있다
 *   2. 토큰 원문은 DB 에 들어가지 않는다
 *   3. 쓰면 비밀번호가 바뀌고 세대 번호가 올라간다(다른 기기 로그아웃), 한 번만 쓸 수 있다
 *   4. 기한 · 주소 바뀜 · 관리자 계정은 막는다
 */

interface Player {
  id: number;
  nickname: string;
  email: string | null;
  email_verified_at: Date | null;
  is_admin: boolean;
  password_hash: string | null;
  token_epoch: number;
}
interface Row {
  token_hash: string;
  player_id: number;
  email: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

const db = {
  players: [] as Player[],
  rows: [] as Row[],
  writes: [] as unknown[],
  clearedLocks: [] as string[],
};

type PlayerWhere = {
  email?: string;
  email_verified_at?: { not: null };
  is_admin?: boolean;
  nickname?: { equals: string; mode: 'insensitive' };
};

const tables = {
  players: {
    findFirst: async ({ where }: { where: PlayerWhere }) =>
      db.players.find(
        (p) =>
          (where.email === undefined || p.email === where.email) &&
          (where.email_verified_at === undefined || p.email_verified_at !== null) &&
          (where.is_admin === undefined || p.is_admin === where.is_admin) &&
          (where.nickname === undefined || p.nickname.toLowerCase() === where.nickname.equals.toLowerCase()),
      ) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: { password_hash: string; token_epoch: { increment: number } } }) => {
      const p = db.players.find((x) => x.id === where.id)!;
      p.password_hash = data.password_hash;
      p.token_epoch += data.token_epoch.increment;
      db.writes.push(data);
      return p;
    },
  },
  password_resets: {
    aggregate: async ({ where }: { where: { player_id: number } }) => {
      const mine = db.rows.filter((r) => r.player_id === where.player_id);
      const last = mine.reduce<Date | null>((a, r) => (a === null || r.created_at > a ? r.created_at : a), null);
      return { _max: { created_at: last } };
    },
    count: async ({ where }: { where: { player_id: number; created_at: { gt: Date } } }) =>
      db.rows.filter((r) => r.player_id === where.player_id && r.created_at > where.created_at.gt).length,
    deleteMany: async ({ where }: { where: { player_id: number; used_at: null } }) => {
      db.rows = db.rows.filter((r) => !(r.player_id === where.player_id && r.used_at === null));
      return {};
    },
    create: async ({ data }: { data: Omit<Row, 'used_at' | 'created_at'> }) => {
      db.writes.push(data);
      db.rows.push({ ...data, used_at: null, created_at: new Date() });
      return {};
    },
    findUnique: async ({ where }: { where: { token_hash: string } }) => {
      const row = db.rows.find((r) => r.token_hash === where.token_hash);
      if (!row) return null;
      const p = db.players.find((x) => x.id === row.player_id)!;
      return {
        player_id: row.player_id,
        email: row.email,
        expires_at: row.expires_at,
        used_at: row.used_at,
        players: { email: p.email, email_verified_at: p.email_verified_at, is_admin: p.is_admin, nickname: p.nickname },
      };
    },
    update: async ({ where, data }: { where: { token_hash: string }; data: { used_at: Date } }) => {
      const row = db.rows.find((r) => r.token_hash === where.token_hash);
      if (row) row.used_at = data.used_at;
      return {};
    },
  },
  login_failures: {
    deleteMany: async ({ where }: { where: { key: string } }) => {
      db.clearedLocks.push(where.key);
      return {};
    },
  },
};

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: async () => ({ ...tables, $transaction: async <T,>(fn: (tx: typeof tables) => Promise<T>) => fn(tables) }),
  TX_OPTIONS: {},
}));

const sent: { to: string; text: string }[] = [];
vi.mock('@/lib/mailer', () => ({
  isMailConfigured: () => true,
  sendMail: async (mail: { to: string; text: string }) => {
    sent.push(mail);
    return true;
  },
}));

const { requestPasswordReset, checkPasswordReset, consumePasswordReset, isPasswordResetAvailable } = await import(
  '@/lib/password-reset'
);
const { verifyPassword } = await import('@/lib/auth');

const BASE = 'https://arcade.example.com';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('EMAIL_MASKING', 'off');
  db.players = [
    { id: 1, nickname: 'Pumlin', email: 'pumlin@example.com', email_verified_at: new Date(), is_admin: false, password_hash: null, token_epoch: 0 },
    { id: 2, nickname: 'fresh', email: 'fresh@example.com', email_verified_at: null, is_admin: false, password_hash: null, token_epoch: 0 },
    { id: 3, nickname: 'admin', email: 'admin@example.com', email_verified_at: new Date(), is_admin: true, password_hash: null, token_epoch: 0 },
  ];
  db.rows = [];
  db.writes = [];
  db.clearedLocks = [];
  sent.length = 0;
});

/** 마지막 메일의 링크에서 토큰 원문을 꺼낸다 */
function lastToken(): string {
  const m = /\/reset-password\?token=([^\s]+)/.exec(sent.at(-1)!.text);
  return decodeURIComponent(m![1]!);
}

describe('requestPasswordReset — 누구에게 메일이 가나', () => {
  it('확인된 이메일로 찾으면 그 주소로 링크가 간다 (대소문자 · 공백 무시)', async () => {
    expect(await requestPasswordReset('  PUMLIN@example.com ', BASE)).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('pumlin@example.com');
    expect(sent[0]!.text).toContain(`${BASE}/reset-password?token=`);
  });

  it('아이디로 찾아도 확인된 이메일로 간다 (대소문자 무시)', async () => {
    expect(await requestPasswordReset('pumlin', BASE)).toBe('sent');
    expect(sent[0]!.to).toBe('pumlin@example.com');
  });

  it('확인 전 이메일 · 없는 계정 · 관리자에게는 보내지 않는다', async () => {
    expect(await requestPasswordReset('fresh@example.com', BASE)).toBe('no-target');
    expect(await requestPasswordReset('fresh', BASE)).toBe('no-target');
    expect(await requestPasswordReset('nobody@example.com', BASE)).toBe('no-target');
    expect(await requestPasswordReset('admin', BASE)).toBe('no-target');
    expect(sent).toHaveLength(0);
  });

  it('토큰 원문은 DB 에 쓰지 않는다', async () => {
    await requestPasswordReset('pumlin', BASE);
    const token = lastToken();
    expect(JSON.stringify(db.writes)).not.toContain(token);
  });

  it('같은 계정에 연달아 보내지 않는다 (분당 1통)', async () => {
    expect(await requestPasswordReset('pumlin', BASE)).toBe('sent');
    expect(await requestPasswordReset('pumlin@example.com', BASE)).toBe('too-soon');
    expect(sent).toHaveLength(1);
  });

  it('이메일을 가리는 기간에는 쓸 수 없다', async () => {
    vi.stubEnv('EMAIL_MASKING', 'on');
    expect(isPasswordResetAvailable()).toBe(false);
    expect(await requestPasswordReset('pumlin', BASE)).toBe('unavailable');
  });
});

describe('consumePasswordReset — 링크로 새 비밀번호', () => {
  it('비밀번호가 바뀌고 세대 번호가 올라가며, 로그인 잠금이 풀린다', async () => {
    await requestPasswordReset('pumlin', BASE);
    const token = lastToken();
    expect(await checkPasswordReset(token)).toBe('ok');

    const result = await consumePasswordReset(token, 'new-password-123');
    expect(result).toEqual({ ok: true, playerId: 1, nickname: 'Pumlin' });
    const p = db.players[0]!;
    expect(await verifyPassword('new-password-123', p.password_hash)).toBe(true);
    expect(p.token_epoch).toBe(1);
    expect(db.clearedLocks).toContain('login:pumlin');
  });

  it('한 번만 쓸 수 있다', async () => {
    await requestPasswordReset('pumlin', BASE);
    const token = lastToken();
    await consumePasswordReset(token, 'new-password-123');
    expect(await consumePasswordReset(token, 'another-pass-456')).toEqual({ ok: false, reason: 'used' });
    expect(await checkPasswordReset(token)).toBe('used');
  });

  it('모르는 토큰은 invalid, 기한이 지나면 expired', async () => {
    expect(await checkPasswordReset('nope')).toBe('invalid');
    await requestPasswordReset('pumlin', BASE);
    const token = lastToken();
    db.rows[0]!.expires_at = new Date(Date.now() - 1000);
    expect(await consumePasswordReset(token, 'new-password-123')).toEqual({ ok: false, reason: 'expired' });
    expect(db.players[0]!.token_epoch).toBe(0);
  });

  it('보낸 뒤 주소가 바뀌었거나 확인이 풀리면 옛 링크는 죽는다', async () => {
    await requestPasswordReset('pumlin', BASE);
    const token = lastToken();
    db.players[0]!.email = 'other@example.com';
    expect(await checkPasswordReset(token)).toBe('changed');
    db.players[0]!.email = 'pumlin@example.com';
    db.players[0]!.email_verified_at = null;
    expect(await consumePasswordReset(token, 'new-password-123')).toEqual({ ok: false, reason: 'changed' });
  });

  it('새 링크를 받으면 옛 링크는 닫힌다', async () => {
    await requestPasswordReset('pumlin', BASE);
    const first = lastToken();
    db.rows[0]!.created_at = new Date(Date.now() - 2 * 60 * 1000); // 간격 제한을 지난 것으로
    await requestPasswordReset('pumlin', BASE);
    expect(await checkPasswordReset(first)).toBe('invalid');
    expect(await checkPasswordReset(lastToken())).toBe('ok');
  });
});
