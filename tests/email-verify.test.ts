import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 이메일 인증 — **링크 한 장이 무엇을 보증하는가**.
 *
 * 확인하려는 것은 SQL 이 아니라 판정입니다. 그래서 DB 는 대역으로 세우고,
 * 라우트가 받는 답(ok / expired / used / changed / invalid)이 상황마다 맞게
 * 나오는지만 봅니다.
 *
 * 특히 두 가지를 못 박아 둡니다.
 *   1. 토큰 **원문이 DB 에 저장되지 않는다** — 표가 새도 그 값으로 남의 계정을
 *      인증할 수 없어야 합니다 (비밀번호를 해시로 두는 것과 같은 이유).
 *   2. 보낸 뒤 주소가 바뀌면 **옛 링크는 죽는다** — 아니면 예전 주소로 받은
 *      링크가 지금 주소를 확인해 줍니다.
 */

interface Row {
  token_hash: string;
  player_id: number;
  email: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

/** DB 대역 — players 한 줄과 email_verifications 몇 줄만 흉내 냅니다 */
const db = {
  player: { email: null as string | null, email_verified_at: null as Date | null },
  rows: [] as Row[],
  /** 실제로 실행된 SQL — "원문을 넣지 않았는가" 를 여기서 봅니다 */
  params: [] as unknown[][],
};

function fakeQuery(sql: string, params: unknown[] = []) {
  db.params.push(params);

  if (sql.includes('SELECT email, email_verified_at FROM players')) {
    return { rows: [{ ...db.player }] };
  }
  if (sql.includes('max(created_at)')) {
    const mine = db.rows.filter((r) => r.player_id === params[0]);
    const last = mine.reduce<Date | null>(
      (acc, r) => (acc === null || r.created_at > acc ? r.created_at : acc),
      null,
    );
    const hourAgo = Date.now() - 60 * 60 * 1000;
    return {
      rows: [
        {
          last_at: last,
          hour_count: String(mine.filter((r) => r.created_at.getTime() > hourAgo).length),
        },
      ],
    };
  }
  if (sql.startsWith('DELETE FROM email_verifications')) {
    db.rows = db.rows.filter((r) => !(r.player_id === params[0] && r.used_at === null));
    return { rows: [] };
  }
  if (sql.includes('INSERT INTO email_verifications')) {
    db.rows.push({
      token_hash: params[0] as string,
      player_id: params[1] as number,
      email: params[2] as string,
      expires_at: params[3] as Date,
      used_at: null,
      created_at: new Date(),
    });
    return { rows: [] };
  }
  if (sql.includes('FROM email_verifications v')) {
    const row = db.rows.find((r) => r.token_hash === params[0]);
    return {
      rows: row
        ? [
            {
              player_id: row.player_id,
              email: row.email,
              expires_at: row.expires_at,
              used_at: row.used_at,
              current_email: db.player.email,
              verified_at: db.player.email_verified_at,
            },
          ]
        : [],
    };
  }
  if (sql.includes('UPDATE players SET email_verified_at')) {
    db.player.email_verified_at ??= new Date();
    return { rows: [] };
  }
  if (sql.includes('UPDATE email_verifications SET used_at')) {
    const row = db.rows.find((r) => r.token_hash === params[0]);
    if (row) row.used_at = new Date();
    return { rows: [] };
  }
  return { rows: [] };
}

/** getDb() 가 돌려주는 것 중 이 파일이 쓰는 두 가지만 */
interface FakeDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
}

const fakeDb: FakeDb = {
  query: async (sql, params) => fakeQuery(sql, params) as { rows: Record<string, unknown>[] },
  transaction: async (fn) => fn(fakeDb),
};

vi.mock('@/lib/db', () => ({ getDb: async () => fakeDb }));

const sent: { to: string; text: string }[] = [];
vi.mock('@/lib/mailer', () => ({
  isMailConfigured: () => true,
  sendMail: async (mail: { to: string; text: string }) => {
    sent.push(mail);
    return true;
  },
}));

const { consumeVerification, issueVerification, sendVerificationMail } = await import(
  '@/lib/email-verify'
);

beforeEach(() => {
  db.player = { email: 'pumlin@example.com', email_verified_at: null };
  db.rows = [];
  db.params = [];
  sent.length = 0;
});

/** 발급하고 원문 토큰을 꺼내 온다 */
async function issue(): Promise<string> {
  const r = await issueVerification(1, { skipThrottle: true });
  if (!r.ok) throw new Error(`발급 실패: ${r.reason}`);
  return r.token;
}

describe('issueVerification — 토큰 발급', () => {
  it('원문을 DB 에 넣지 않는다 — 표가 새도 그 값으로 인증할 수 없어야 한다', async () => {
    const token = await issue();
    const flat = db.params.flat().map(String);
    expect(flat).not.toContain(token);
    // 대신 해시가 들어가 있다 (sha256 = 64자 hex)
    expect(db.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.rows[0].token_hash).not.toBe(token);
  });

  it('이메일이 없는 계정에는 발급하지 않는다 (소셜 전용)', async () => {
    db.player.email = null;
    const r = await issueVerification(1, { skipThrottle: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-email');
  });

  it('이미 확인된 계정에는 발급하지 않는다', async () => {
    db.player.email_verified_at = new Date();
    const r = await issueVerification(1, { skipThrottle: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-verified');
  });

  it('새로 발급하면 이전 미사용 토큰은 죽는다 — 메일함에 살아 있는 링크가 쌓이면 안 된다', async () => {
    const old = await issue();
    await issue();
    expect(await consumeVerification(old)).toBe('invalid');
  });

  it('연달아 보내면 막는다 (재발송 제한)', async () => {
    await issue();
    const r = await issueVerification(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('too-soon');
      expect(r.retryAfterS).toBeGreaterThan(0);
    }
  });
});

describe('consumeVerification — 링크를 열었을 때', () => {
  it('정상 링크는 확인 도장을 찍는다', async () => {
    const token = await issue();
    expect(await consumeVerification(token)).toBe('ok');
    expect(db.player.email_verified_at).not.toBeNull();
  });

  it('두 번째부터는 used — 링크는 메일함에 영구히 남는다', async () => {
    const token = await issue();
    await consumeVerification(token);
    expect(await consumeVerification(token)).toBe('used');
  });

  it('없는 토큰은 invalid', async () => {
    await issue();
    expect(await consumeVerification('아무거나')).toBe('invalid');
  });

  it('기한이 지나면 expired', async () => {
    const token = await issue();
    db.rows[0].expires_at = new Date(Date.now() - 1000);
    expect(await consumeVerification(token)).toBe('expired');
    expect(db.player.email_verified_at).toBeNull();
  });

  it('보낸 뒤 주소가 바뀌면 changed — 옛 링크로 새 주소를 확인해 주면 안 된다', async () => {
    const token = await issue();
    db.player.email = 'somewhere-else@example.com';
    expect(await consumeVerification(token)).toBe('changed');
    expect(db.player.email_verified_at).toBeNull();
  });
});

describe('sendVerificationMail — 실제로 나가는 것', () => {
  it('본문의 링크에 원문 토큰이 실리고, 그 링크로 확인된다', async () => {
    const result = await sendVerificationMail(1, 'https://arcade.example.com/');
    expect(result.ok).toBe(true);

    const link = sent[0].text.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeDefined();
    // 주소 끝의 슬래시가 겹치지 않아야 한다
    expect(link).toContain('https://arcade.example.com/api/auth/verify?token=');

    const token = new URL(link!).searchParams.get('token')!;
    expect(await consumeVerification(token)).toBe('ok');
  });

  it('보낼 곳이 없으면 보내지 않는다', async () => {
    db.player.email = null;
    const result = await sendVerificationMail(1, 'https://arcade.example.com');
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
