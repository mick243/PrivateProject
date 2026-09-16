import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, type SessionUser } from './auth-types';
import { getDb } from './db';
import { isUniqueViolation, violatedConstraint } from './pg-errors';

/**
 * 인증.
 *
 * 둘러보기와 제보는 로그인 없이도 됩니다. **이름이 붙는 일**(리뷰·글·댓글·채보
 * 평가)은 로그인이 있어야 합니다 — 그 이름의 근거가 세션뿐이기 때문입니다
 * (lib/use-player.ts). 관리자만 되는 건 오락실 정보 수정과 제보 삭제입니다.
 *
 * 계정은 세 갈래로 들어옵니다. 셋 다 마지막에는 players 한 줄이 됩니다 —
 * 관리자도, 소셜로 들어온 사람도 제보·리뷰를 남기는 한 명의 플레이어입니다.
 *   1. 관리자 : 근거가 DB 가 아니라 **환경변수**입니다 (ADMIN_NICKNAME /
 *      ADMIN_PASSWORD). 해시를 시드에 박으면 비밀번호가 저장소에 남고, 바꾸려면
 *      DB 를 손대야 합니다. 로그인할 때마다 env 와 DB 를 맞춰 둡니다.
 *   2. 아이디/비밀번호 가입 : createAccount() — players.password_hash 에 scrypt.
 *   3. 소셜 로그인 : linkOAuthAccount() — 비밀번호 없이 player_identities 로
 *      묶습니다 (lib/oauth.ts 가 "무엇으로 본인을 증명했는가"를 맡습니다).
 *
 * 세션은 셋 모두 같습니다 — 서명한 쿠키 한 장(sealPayload). 세션 테이블을 두면
 * 만료·정리가 따라오는데, 지금 담을 게 "누구인가 · 관리자인가" 두 줄뿐이라
 * 값을 그대로 서명해 들려보냅니다.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** 쿠키 수명. 관리 작업은 뜸하게 하므로 짧으면 매번 다시 로그인하게 됩니다 */
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;

const DEFAULT_ADMIN_NICKNAME = '관리자';
/** ADMIN_PASSWORD 가 없을 때 **개발 환경에서만** 쓰는 값 */
const DEV_ADMIN_PASSWORD = 'admin1234';

// ─── 비밀번호 ────────────────────────────────────────────────
// scrypt 는 node 기본 제공이라 의존성이 늘지 않고, bcrypt 와 달리 72바이트
// 절단이 없습니다. 형식은 'scrypt$<salt hex>$<key hex>' — 나중에 파라미터를
// 올리더라도 앞의 알고리즘 이름으로 옛 해시를 구분할 수 있습니다.

const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(
    password.normalize('NFKC'),
    Buffer.from(saltHex, 'hex'),
    expected.length,
  );
  // 길이가 다르면 timingSafeEqual 이 던집니다 — 먼저 거릅니다.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ─── 세션 쿠키 ───────────────────────────────────────────────

interface TokenPayload {
  pid: number;
  /**
   * 발급 당시의 `players.token_epoch` — **세션 회수의 근거**.
   *
   * 이름과 관리자 여부는 더 이상 봉하지 않습니다. 쿠키에 박아 두면 7일 동안
   * 그때의 값이고, 요청마다 DB 를 보는 지금은 더 정확한 답이 옆에 있습니다.
   * 서명 안에 든 값은 "누구인가"와 "어느 세대인가" 둘뿐입니다.
   */
  ep: number;
  /** epoch 초 */
  exp: number;
}

let warnedAboutSecret = false;

function sessionSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (secret && secret.length >= 16) return secret;

  if (process.env.NODE_ENV === 'production') {
    // 운영에서 고정 문자열로 서명하면 누구나 관리자 쿠키를 만들 수 있습니다.
    throw new Error('AUTH_SECRET 이 설정되지 않았습니다 (16자 이상 필요)');
  }
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn('[auth] AUTH_SECRET 미설정 — 개발용 고정 키로 서명합니다');
  }
  return 'arcade-finder-dev-secret-do-not-use-in-production';
}

function sign(body: string): string {
  return createHmac('sha256', sessionSecret()).update(body).digest('base64url');
}

/**
 * 값을 그대로 들려보내되 **고쳐 쓰지는 못하게** 봉합니다 — `<본문>.<서명>`.
 *
 * 세션 쿠키가 이 모양이고, OAuth 의 state 쿠키도 같은 걸 씁니다
 * (lib/oauth.ts). 저장소가 필요 없는 대신 값이 밖으로 나가므로, 비밀이 아닌
 * 것만 담습니다. `ttlSeconds` 는 본문 안에 `exp` 로 함께 봉해집니다 — 쿠키
 * 만료는 브라우저가 지우는 시늉일 뿐이라 서버가 따로 봐야 합니다.
 */
export function sealPayload(payload: object, ttlSeconds: number): string {
  const withExp = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(withExp)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** sealPayload 의 짝. 서명이 다르거나 기한이 지났으면 null */
export function openPayload<T>(token: string | null | undefined): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
    return payload as T;
  } catch {
    return null;
  }
}

export function createSessionToken(playerId: number, epoch: number): string {
  const payload: Omit<TokenPayload, 'exp'> = { pid: playerId, ep: epoch };
  return sealPayload(payload, SESSION_MAX_AGE_S);
}

/**
 * 서명과 기한만 본 결과 — **아직 로그인 여부가 아닙니다.**
 * 이 사람이 지금도 유효한지는 `getSession` 이 DB 의 세대 번호로 판단합니다.
 */
export function readSessionToken(
  token: string | null | undefined,
): { playerId: number; epoch: number } | null {
  const payload = openPayload<TokenPayload>(token);
  if (!payload) return null;
  if (!Number.isInteger(payload.pid) || payload.pid <= 0) return null;
  if (!Number.isInteger(payload.ep) || payload.ep < 0) return null;
  return { playerId: payload.pid, epoch: payload.ep };
}

/**
 * 쿠키 헤더에서 값 하나를 꺼냅니다.
 *
 * next/headers 의 cookies() 를 쓰지 않는 이유: 라우트 핸들러가 이미 Request 를
 * 들고 있어 추가 async 동적 API 없이 읽을 수 있고, requireAdmin(request) 한
 * 시그니처로 모든 경로에서 같게 동작합니다.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 세션이 가리키는 사람. 쿠키 한 장과 **players 한 줄**을 함께 봅니다.
 *
 * 예전에는 쿠키만 읽었습니다. 서명이 맞고 기한이 남았으면 그걸로 끝이라,
 * 서버가 세션을 끊을 방법이 없었습니다 — 비밀번호를 바꿔도, 계정을 지워도
 * 이미 나간 쿠키는 7일을 살았습니다(H12). 이제 요청마다 세대 번호를 맞춰 봅니다.
 *
 * 조회 한 번으로 세 가지가 같이 해결됩니다.
 *   - **회수** : `token_epoch` 이 다르면 무효 (revokeSessions 가 올립니다)
 *   - **탈퇴** : 줄이 없으면 무효 — 쿠키 만료를 기다리지 않습니다
 *   - **최신 이름·권한** : 쿠키에 박힌 옛 값 대신 지금 값을 돌려줍니다
 *
 * 값을 캐시하지 않습니다. 몇 초짜리 캐시를 두면 그 몇 초 동안은 회수가 회수가
 * 아니고, 인스턴스가 둘이면 어느 쪽에 걸리느냐에 따라 답이 달라집니다
 * (PERFORMANCE.md 4부 15절). 비용은 인덱스를 탄 PK 조회 한 번이고, 쿠키가 없는
 * 요청은 DB 까지 가지도 않습니다 — 둘러보기만 하는 사람은 그대로입니다.
 */
export async function getSession(request: Request): Promise<SessionUser | null> {
  const token = readSessionToken(readCookie(request, SESSION_COOKIE));
  if (!token) return null;

  const row = await playerRow(token.playerId);
  if (!row || row.epoch !== token.epoch) return null;

  return { playerId: token.playerId, nickname: row.nickname, isAdmin: row.isAdmin };
}

/** 세션 판정에 필요한 players 한 줄. 계정이 없으면 null */
async function playerRow(
  playerId: number,
): Promise<{ nickname: string; isAdmin: boolean; epoch: number } | null> {
  const db = await getDb();
  const { rows } = await db.query<{
    nickname: string;
    is_admin: boolean;
    token_epoch: number;
  }>(`SELECT nickname, is_admin, token_epoch FROM players WHERE id = $1`, [playerId]);

  const row = rows[0];
  if (!row) return null;
  return { nickname: row.nickname, isAdmin: !!row.is_admin, epoch: Number(row.token_epoch) };
}

/**
 * 그 계정의 **지난 세션을 한꺼번에 무효로** 만듭니다.
 *
 * 비밀번호를 바꿀 때(setPlayerPassword)와 본인이 "다른 기기에서 로그아웃" 을
 * 누를 때 부릅니다 (app/api/account/sessions). 부른 쪽은 자기 쿠키를 새 번호로
 * 다시 발급받아야 합니다 — 안 그러면 방금 누른 사람도 같이 튕깁니다.
 */
export async function revokeSessions(playerId: number): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE players SET token_epoch = token_epoch + 1 WHERE id = $1`, [playerId]);
}

/**
 * 지금 세대 번호로 쿠키를 발급합니다.
 *
 * 번호를 인자로 받지 않고 **여기서 읽습니다** — 호출부가 들고 있던 번호는
 * 직전에 올라갔을 수 있고(비밀번호 변경), 한 번 어긋나면 방금 로그인한 사람이
 * 곧바로 로그아웃되는 모양으로 나타납니다. 읽는 자리를 하나로 둡니다.
 */
export async function setSessionCookie(
  res: NextResponse,
  playerId: number,
): Promise<NextResponse> {
  const row = await playerRow(playerId);
  res.cookies.set(SESSION_COOKIE, createSessionToken(playerId, row?.epoch ?? 0), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}

// ─── 권한 ────────────────────────────────────────────────────

/** 세션이 말하는 주인. 없으면 null — 익명을 허용하는 경로가 씁니다(제보) */
export async function sessionPlayerId(request: Request): Promise<number | null> {
  return (await getSession(request))?.playerId ?? null;
}

export type PlayerGuard =
  | { ok: true; playerId: number }
  | { ok: false; response: NextResponse };

/**
 * 로그인이 필요한 라우트의 첫 줄.
 *
 *   const guard = await requirePlayer(request);
 *   if (!guard.ok) return guard.response;
 *
 * 예전에는 동기 함수였습니다 — "이 세션의 주인이 누구인가" 는 서명 안에 들어
 * 있으니 DB 를 볼 이유가 없다는 판단이었고, 그 말은 **세션을 끊을 수도 없다**는
 * 뜻이었습니다. 이제 getSession 이 세대 번호를 맞춰 보므로 여기도 async 입니다.
 */
export async function requirePlayer(request: Request): Promise<PlayerGuard> {
  const playerId = await sessionPlayerId(request);
  if (playerId === null) {
    return {
      ok: false,
      response: NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 }),
    };
  }
  return { ok: true, playerId };
}

export type AdminGuard =
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse };

/**
 * 관리자 전용 라우트의 첫 줄.
 *
 *   const guard = await requireAdmin(request);
 *   if (!guard.ok) return guard.response;
 *
 * 쿠키의 값을 믿지 않는다는 성질은 그대로입니다 — 다만 이제 **모든 세션**이
 * DB 를 보므로(getSession) 여기만 따로 확인하지 않습니다. 권한을 뗀 계정의
 * 쿠키가 만료까지 통하는 일은 없습니다.
 */
export async function requireAdmin(request: Request): Promise<AdminGuard> {
  const user = await getSession(request);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: '관리자 로그인이 필요합니다' }, { status: 401 }),
    };
  }
  if (!user.isAdmin) {
    return {
      ok: false,
      response: NextResponse.json({ error: '관리자 권한이 없습니다' }, { status: 403 }),
    };
  }
  return { ok: true, user };
}

/**
 * "관리자면 무엇이든, 아니면 본인 것만" 인 경로에서 씁니다 (게시판 글·댓글 삭제).
 *
 * requireAdmin 과 달리 권한이 없어도 응답을 만들지 않습니다 — 여기서 401 을
 * 돌려주면 자기 글을 지우려던 일반 사용자까지 막힙니다.
 */
export async function isAdminRequest(request: Request): Promise<boolean> {
  return (await getSession(request))?.isAdmin === true;
}

// ─── 관리자 계정 ─────────────────────────────────────────────

/** 설정된 관리자 비밀번호. 운영에서 미설정이면 null — 로그인 자체를 막습니다 */
export function configuredAdminPassword(): string | null {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return process.env.NODE_ENV === 'production' ? null : DEV_ADMIN_PASSWORD;
}

export function configuredAdminNickname(): string {
  return process.env.ADMIN_NICKNAME?.trim() || DEFAULT_ADMIN_NICKNAME;
}

/**
 * 관리자 닉네임과 겉보기로 같은 이름인가.
 *
 * DB 의 닉네임 중복 차단이 lower() 기준이라(migrate-027), 예약어 검사만 바이트
 * 일치로 두면 'Admin' 예약에 'admin' 이 통과한 뒤 관리자 첫 로그인
 * (ensureAdminAccount)이 UNIQUE 에 막히는 어긋남이 생깁니다.
 */
export function isReservedNickname(name: string): boolean {
  return name.toLowerCase() === configuredAdminNickname().toLowerCase();
}

/**
 * env 의 관리자 계정을 players 에 맞춰 둡니다 (없으면 만들고, 다르면 고칩니다).
 *
 * 로그인 시도마다 부릅니다. 덕분에 .env 의 ADMIN_PASSWORD 만 바꾸면 다음
 * 로그인부터 새 비밀번호가 통하고, DB 를 직접 손댈 일이 없습니다. 비용은
 * 실패한 로그인 1회당 scrypt 한 번 더 — 초당 수천 번 들어오는 경로가 아닙니다.
 */
export async function ensureAdminAccount(): Promise<{ id: number; nickname: string } | null> {
  const password = configuredAdminPassword();
  if (!password) return null;

  const nickname = configuredAdminNickname();
  const db = await getDb();

  const { rows } = await db.query<{ id: number; is_admin: boolean; password_hash: string | null }>(
    `SELECT id, is_admin, password_hash FROM players WHERE nickname = $1`,
    [nickname],
  );

  const existing = rows[0];
  if (!existing) {
    const { rows: created } = await db.query<{ id: number }>(
      `INSERT INTO players (nickname, is_admin, password_hash) VALUES ($1, TRUE, $2)
       RETURNING id`,
      [nickname, await hashPassword(password)],
    );
    console.log(`[auth] 관리자 계정 생성 — ${nickname}`);
    return { id: Number(created[0].id), nickname };
  }

  const id = Number(existing.id);
  if (!existing.is_admin || !(await verifyPassword(password, existing.password_hash))) {
    // 비밀번호가 바뀐 것이라면 지난 관리자 세션도 끊습니다 — setPlayerPassword 와 같은 규칙.
    await db.query(
      `UPDATE players
          SET is_admin = TRUE, password_hash = $2, token_epoch = token_epoch + 1
        WHERE id = $1`,
      [id, await hashPassword(password)],
    );
  }
  return { id, nickname };
}

/** 닉네임+비밀번호로 로그인. 실패 이유는 밖에 알리지 않습니다 */
export async function authenticate(
  nickname: string,
  password: string,
): Promise<SessionUser | null> {
  const db = await getDb();
  const { rows } = await db.query<{
    id: number;
    nickname: string;
    is_admin: boolean;
    password_hash: string | null;
  }>(`SELECT id, nickname, is_admin, password_hash FROM players WHERE nickname = $1`, [
    nickname.trim(),
  ]);

  const row = rows[0];
  // 비밀번호가 없는 계정(= 일반 플레이어)은 로그인 대상이 아닙니다.
  if (!row || !(await verifyPassword(password, row.password_hash))) return null;

  return { playerId: Number(row.id), nickname: row.nickname, isAdmin: !!row.is_admin };
}

// ─── 일반 계정 가입 ──────────────────────────────────────────

export type SignupResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'taken' | 'reserved' | 'email-taken' };

/**
 * 아이디/비밀번호로 계정을 만듭니다.
 *
 * 닉네임은 players 에서 이미 UNIQUE 라서 중복은 DB 가 막습니다. 그런데 여기서
 * 미리 한 번 더 보는 이유는 **관리자 닉네임** 때문입니다 — 관리자 계정은 첫
 * 로그인 전까지 players 에 없으므로(ensureAdminAccount), 그 전에 같은 이름으로
 * 가입하면 UNIQUE 에 걸리지 않고 자리를 먼저 차지합니다. 그 뒤 관리자가
 * 로그인하면 ensureAdminAccount 가 그 줄에 is_admin 을 켜 버립니다.
 *
 * 미리 본 뒤에도 INSERT 가 23505 로 떨어질 수 있습니다(같은 순간에 두 명이
 * 같은 이름으로 가입). 그건 호출부에서 잡습니다.
 */
export async function createAccount(
  nickname: string,
  password: string,
  email: string,
): Promise<SignupResult> {
  const name = nickname.trim();
  if (isReservedNickname(name)) return { ok: false, reason: 'reserved' };

  const db = await getDb();
  /*
    이름과 이메일 중복을 **한 번에** 봅니다. 두 번 나눠 물으면 "이름은 되는데
    이메일이 안 된다" 를 두 번의 왕복으로 알게 됩니다.

    이메일은 `email_verified_at IS NOT NULL` 인 줄만 셉니다 — 확인하지 않은 주소로
    자리를 맡아 두면, 남의 이메일을 적어 그 사람의 가입을 막을 수 있습니다.
    이름은 대소문자만 다른 것도 같은 이름으로 봅니다 (migrate-027 의 lower() 인덱스와
    같은 기준 — 여기만 바이트 일치로 보면 안내 없이 23505 로 떨어집니다).
  */
  const { rows: dup } = await db.query<{ nickname_taken: boolean; email_taken: boolean }>(
    `SELECT bool_or(lower(nickname) = lower($1)) AS nickname_taken,
            bool_or(lower(email) = lower($2) AND email_verified_at IS NOT NULL) AS email_taken
       FROM players
      WHERE lower(nickname) = lower($1) OR lower(email) = lower($2)`,
    [name, email],
  );
  if (dup[0]?.nickname_taken) return { ok: false, reason: 'taken' };
  if (dup[0]?.email_taken) return { ok: false, reason: 'email-taken' };

  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO players (nickname, password_hash, email) VALUES ($1, $2, $3) RETURNING id`,
    [name, await hashPassword(password), email],
  );
  // 가입으로 관리자가 되지는 않습니다. is_admin 은 DB 기본값 FALSE 그대로 둡니다.
  return { ok: true, user: { playerId: Number(rows[0].id), nickname: name, isAdmin: false } };
}

/**
 * 23505 를 받았을 때 무엇이 겹쳤는지 — createAccount 의 선검사와 INSERT 사이에
 * 남이 먼저 들어온 경우입니다.
 *
 * 제약 이름을 하나하나 맞춰 보는 대신 'email' 이 들어 있는지만 봅니다. 이름은
 * 마이그레이션마다 달라질 수 있지만 어느 쪽을 가리키는지는 그 낱말로 충분하고,
 * 틀려도 '이미 쓰는 아이디입니다' 로 떨어질 뿐 안전한 쪽입니다.
 */
export function signupConflictReason(err: unknown): 'taken' | 'email-taken' {
  return violatedConstraint(err)?.includes('email') ? 'email-taken' : 'taken';
}

// ─── 소셜 계정 연결 ──────────────────────────────────────────

/** 닉네임을 players 에 넣을 수 있는 모양으로 다듬습니다 (빈 값 → 제공자 이름) */
function normalizeNickname(raw: string | null, fallback: string): string {
  // NFC 통일은 lib/validation.ts nicknameField 와 같은 이유 — 이 경로(소셜 첫
  // 가입)는 그 스키마를 거치지 않고 제공자가 준 이름이 바로 들어옵니다.
  const name = (raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 100);
  return name || fallback;
}

/**
 * 소셜 신원(provider + uid)을 players 한 줄에 묶고 그 사람을 돌려줍니다.
 *
 *   - 이미 연결돼 있으면 그 계정으로 로그인합니다.
 *   - 처음이면 players 를 새로 만들고 연결합니다.
 *
 * **이메일로 기존 계정을 찾지 않습니다.** 제공자마다 이메일 검증 여부가 다르고,
 * 검증하지 않은 이메일로 계정을 합치면 남의 계정을 가져가는 길이 열립니다.
 * 같은 사람이 카카오와 구글로 각각 들어오면 지금은 서로 다른 계정입니다 —
 * 계정 연결은 "로그인한 상태에서 추가 연결" 로 따로 붙일 자리입니다.
 *
 * 닉네임이 겹치면(플레이어 목록에 이미 같은 이름이 있으면) 뒤에 숫자를 붙입니다.
 * 가입을 실패시키는 대신 이름을 양보하는 쪽인데, 소셜 로그인은 제공자 화면에서
 * 곧장 돌아오는 흐름이라 그 자리에서 실패시키면 되돌릴 방법이 없기 때문입니다.
 *
 * 다만 그렇게 붙인 이름은 **본인이 고른 적이 없습니다.** 그래서 새로 만든 줄에는
 * nickname_pending 을 켜 두고(db/migrate-026-oauth-nickname.sql), 콜백이 곧바로
 * `/welcome` 로 보내 한 번 물어봅니다 (claimNickname 이 그 답을 받습니다).
 * `needsNickname` 이 그 신호입니다 — 이미 연결된 계정도 지난번에 답하지 않고
 * 나갔으면 켜진 채로 남아 있어, 값을 만들지 않고 DB 에 있는 것을 그대로 읽습니다.
 */
export async function linkOAuthAccount(params: {
  provider: string;
  providerUid: string;
  nickname: string | null;
  email: string | null;
}): Promise<{ user: SessionUser; needsNickname: boolean }> {
  const db = await getDb();

  const { rows: linked } = await db.query<{
    id: number;
    nickname: string;
    is_admin: boolean;
    nickname_pending: boolean;
  }>(
    `SELECT p.id, p.nickname, p.is_admin, p.nickname_pending
       FROM player_identities i
       JOIN players p ON p.id = i.player_id
      WHERE i.provider = $1 AND i.provider_uid = $2`,
    [params.provider, params.providerUid],
  );
  if (linked[0]) {
    return {
      user: {
        playerId: Number(linked[0].id),
        nickname: linked[0].nickname,
        isAdmin: !!linked[0].is_admin,
      },
      needsNickname: !!linked[0].nickname_pending,
    };
  }

  const base = normalizeNickname(params.nickname, params.provider);
  let playerId: number | null = null;
  let nickname = base;

  // 이름을 양보하는 루프. 관리자 닉네임도 여기서 함께 비켜 갑니다.
  for (let attempt = 0; attempt < 20 && playerId === null; attempt++) {
    const candidate =
      attempt === 0 ? base : `${base.slice(0, 94)}${attempt + 1}`;
    if (isReservedNickname(candidate)) continue;
    try {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO players (nickname, nickname_pending) VALUES ($1, TRUE) RETURNING id`,
        [candidate],
      );
      playerId = Number(rows[0].id);
      nickname = candidate;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (playerId === null) throw new Error('닉네임을 정할 수 없습니다');

  await db.query(
    `INSERT INTO player_identities (provider, provider_uid, player_id, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_uid) DO NOTHING`,
    [params.provider, params.providerUid, playerId, params.email],
  );

  return { user: { playerId, nickname, isAdmin: false }, needsNickname: true };
}

// ─── 소셜로 들어온 사람이 이름을 정하는 자리 ─────────────────

export type NicknameClaim =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'taken' | 'reserved' | 'settled' | 'gone' };

/**
 * `/welcome` 이 받아 온 이름을 players 에 적고 표시를 끕니다.
 *
 * **이미 정한 계정은 여기서 이름을 바꾸지 못합니다**(reason: 'settled').
 * 조건을 빼면 이 라우트가 곧 "언제든 개명" 이 되는데, 그건 다른 기능입니다 —
 * 남이 알던 이름이 예고 없이 바뀌고, 비운 이름을 곧바로 다른 사람이 차지할 수
 * 있어 예전 글의 작성자를 사칭할 길이 열립니다. 지금 필요한 건 "처음 한 번" 뿐입니다.
 *
 * 이름을 그대로 두고 확인만 눌러도 성공입니다 — "이대로 쓰겠다" 도 본인이 고른
 * 것이고, 그러면 다음 로그인에 또 묻지 않습니다.
 *
 * 중복은 미리 보지 않고 UNIQUE 에 맡깁니다. 확인과 UPDATE 사이에 남이 같은
 * 이름을 가져갈 수 있어서 어차피 23505 를 받아야 하고, 그러면 검사가 두 벌이
 * 됩니다 (createAccount 가 선검사를 두는 건 관리자 닉네임 때문인데, 그건 아래에서
 * 따로 봅니다).
 */
export async function claimNickname(
  playerId: number,
  rawNickname: string,
): Promise<NicknameClaim> {
  const name = rawNickname.trim();
  // 관리자 계정은 첫 로그인 전까지 players 에 없으므로 UNIQUE 로는 막히지 않습니다
  // (createAccount 주석과 같은 이유).
  if (isReservedNickname(name)) return { ok: false, reason: 'reserved' };

  const db = await getDb();
  const { rows } = await db.query<{
    nickname: string;
    is_admin: boolean;
    nickname_pending: boolean;
  }>(`SELECT nickname, is_admin, nickname_pending FROM players WHERE id = $1`, [playerId]);

  const row = rows[0];
  if (!row) return { ok: false, reason: 'gone' };
  if (!row.nickname_pending) return { ok: false, reason: 'settled' };

  const user: SessionUser = { playerId, nickname: name, isAdmin: !!row.is_admin };

  if (name === row.nickname) {
    await db.query(`UPDATE players SET nickname_pending = FALSE WHERE id = $1`, [playerId]);
    return { ok: true, user };
  }

  try {
    await db.query(
      `UPDATE players SET nickname = $2, nickname_pending = FALSE WHERE id = $1`,
      [playerId, name],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'taken' };
    throw err;
  }
  return { ok: true, user };
}

// ─── 개인정보 수정 (/account) ────────────────────────────────
/*
 * claimNickname 이 "처음 한 번" 만 허용하는 것과 달리, 여기는 **언제든 개명**입니다.
 * 대신 아무 세션이나 통과시키지 않고 **비밀번호를 다시 물어** 본인임을 확인합니다
 * (app/api/account) — 세션 쿠키는 훔치거나 열어 둔 자리에서 집을 수 있지만
 * 비밀번호는 본인 머릿속에만 있습니다.
 *
 * 소셜로만 가입해 비밀번호가 없는 계정(password_hash IS NULL)은 확인할 대상이
 * 없으므로, 로그인 세션만으로 **첫 비밀번호 설정**을 허용합니다. 설정한 뒤부터는
 * 같은 화면이 비밀번호를 요구합니다.
 */

/** /account 가 화면을 그리기 전에 묻는 것 — 지금 이름과 "비밀번호가 있는가" */
export async function accountStatus(
  playerId: number,
): Promise<{ nickname: string; hasPassword: boolean; isAdmin: boolean } | null> {
  const db = await getDb();
  const { rows } = await db.query<{
    nickname: string;
    password_hash: string | null;
    is_admin: boolean;
  }>(`SELECT nickname, password_hash, is_admin FROM players WHERE id = $1`, [playerId]);
  if (!rows[0]) return null;
  return {
    nickname: rows[0].nickname,
    hasPassword: rows[0].password_hash !== null,
    isAdmin: !!rows[0].is_admin,
  };
}

/** 저장된 해시와 대조합니다. 계정이 없거나 비밀번호가 없으면 false */
export async function verifyPlayerPassword(
  playerId: number,
  password: string,
): Promise<boolean> {
  const db = await getDb();
  const { rows } = await db.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM players WHERE id = $1`,
    [playerId],
  );
  if (!rows[0]) return false;
  return verifyPassword(password, rows[0].password_hash);
}

/**
 * 탈퇴 — players 행을 지웁니다.
 *
 * 나머지는 FK 가 정합니다 (db/schema-*.sql): 글·댓글·추천·리뷰·채보 평가·투표·클리어·
 * 즐겨찾기·소셜 연결·첨부 행은 CASCADE 로 함께 지워지고, **오락실 제보만 SET NULL**
 * 로 남아 익명이 됩니다 — 지도의 근거라 사람이 떠나도 정보는 남겨야 합니다.
 * 개인정보처리방침 2항이 바로 이 규칙을 적은 것이라, 여기를 바꾸면 그 문서도 바꿔야 합니다.
 *
 * 첨부 **파일**은 디스크에 남습니다 (post_images 행만 사라짐). 고아 파일 정리는
 * 배치의 몫입니다 (docs/QA-LAUNCH-READINESS.md M2).
 *
 * 지운 계정의 쿠키는 **다음 요청부터 통하지 않습니다** — getSession 이 players 를
 * 보고 줄이 없으면 세션도 없는 것으로 봅니다. 서명은 7일간 유효한 채로 남지만
 * 가리키는 곳이 사라졌습니다. 쿠키 자체는 라우트가 지웁니다.
 */
export async function deleteAccount(playerId: number): Promise<boolean> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `DELETE FROM players WHERE id = $1 AND is_admin = FALSE RETURNING id`,
    [playerId],
  );
  return rows.length > 0;
}

/**
 * 비밀번호를 설정/변경합니다. 이후 아이디/비밀번호 로그인(authenticate)도 열립니다.
 *
 * **지난 세션을 함께 끊습니다**(token_epoch + 1). 비밀번호를 바꾸는 이유의 절반은
 * "누가 내 계정을 보고 있는 것 같다" 인데, 그때 남의 기기에 열려 있는 창이
 * 그대로 살아 있으면 바꾼 의미가 없습니다. 바꾼 본인의 쿠키는 호출부가
 * setSessionCookie 로 새 번호를 받아 갑니다 (app/api/account PUT).
 */
export async function setPlayerPassword(playerId: number, password: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE players SET password_hash = $2, token_epoch = token_epoch + 1 WHERE id = $1`,
    [playerId, await hashPassword(password)],
  );
}

/**
 * 닉네임 변경 — claimNickname 에서 nickname_pending 조건만 뺀 것.
 *
 * 그 조건이 막던 사칭 위험(비운 이름을 남이 차지)은 여전히 있지만, 여기는
 * 비밀번호 확인을 통과한 뒤에만 도달하고 본인이 바꾸겠다고 한 것입니다.
 * pending 표시는 함께 끕니다 — 본인이 고른 이름이 생겼으므로 /welcome 이
 * 다시 물을 이유가 없습니다.
 */
export async function changeNickname(
  playerId: number,
  rawNickname: string,
): Promise<NicknameClaim> {
  const name = rawNickname.trim();
  if (isReservedNickname(name)) return { ok: false, reason: 'reserved' };

  const db = await getDb();
  const { rows } = await db.query<{ nickname: string; is_admin: boolean }>(
    `SELECT nickname, is_admin FROM players WHERE id = $1`,
    [playerId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'gone' };

  const user: SessionUser = { playerId, nickname: name, isAdmin: !!row.is_admin };

  if (name === row.nickname) {
    await db.query(`UPDATE players SET nickname_pending = FALSE WHERE id = $1`, [playerId]);
    return { ok: true, user };
  }

  try {
    await db.query(
      `UPDATE players SET nickname = $2, nickname_pending = FALSE WHERE id = $1`,
      [playerId, name],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'taken' };
    throw err;
  }
  return { ok: true, user };
}

/** `/welcome` 이 화면을 그리기 전에 묻는 것 — "물어볼 상태인가, 지금 이름은 무엇인가" */
export async function nicknameStatus(
  playerId: number,
): Promise<{ nickname: string; pending: boolean } | null> {
  const db = await getDb();
  const { rows } = await db.query<{ nickname: string; nickname_pending: boolean }>(
    `SELECT nickname, nickname_pending FROM players WHERE id = $1`,
    [playerId],
  );
  if (!rows[0]) return null;
  return { nickname: rows[0].nickname, pending: !!rows[0].nickname_pending };
}

// ─── 로그인 시도 제한 ────────────────────────────────────────
/**
 * 실패 횟수를 **DB 에** 셉니다 (db/migrate-052-login-failures.sql).
 *
 * 예전에는 이 파일의 `Map` 한 개, 즉 그 프로세스의 메모리였습니다. 그 시절 주석이
 * 한계를 이미 적어 뒀습니다 — "서버가 여러 대면 대수만큼 여유가 생기고 재시작하면
 * 풀립니다". 그 '여러 대' 가 이제 현실입니다: 권고 구성이 인스턴스 2개라
 * (PERFORMANCE.md 4부 15절) 카운터도 2개가 되어 **8회 제한이 실질 16회**가 됩니다.
 * 프로세스를 늘리는 것이 곧 방어를 느슨하게 만드는 셈이라, 저장소를 프로세스
 * 밖으로 빼는 것이 다중 프로세스의 전제입니다. 재시작해도 풀리지 않는 것은 덤입니다.
 *
 * **Redis 가 아니라 Postgres 인 이유** — 이미 있는 것이기 때문입니다. 비용은 실패한
 * 시도 1회당 쿼리 1회이고, 이 경로는 초당 수천 번 오는 곳이 아닙니다.
 *
 * 무엇을 키로 세는지는 아래 `clientKey` · `accountKey` 를 보세요 — 그쪽이 이
 * 방어의 **실효**를 결정합니다. 저장소를 옮겨도 키를 공격자가 고를 수 있으면
 * 제한이 없는 것과 같습니다.
 */
const MAX_FAILURES = 8;
const LOCK_MINUTES = 10;

/**
 * 남은 잠금 시간(ms). 0 이면 통과입니다.
 *
 * 기한이 지난 줄은 여기서 지우지 않습니다 — 읽기 경로에 쓰기를 섞으면 잠금
 * 확인마다 DB 에 쓰게 됩니다. 조건에서 `until > now()` 로 걸러 내고, 실제 청소는
 * 다음 실패를 기록할 때 함께 합니다 (noteLoginFailure).
 */
export async function loginLockRemainingMs(key: string): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ remaining_ms: string }>(
    `SELECT EXTRACT(EPOCH FROM (until - now())) * 1000 AS remaining_ms
       FROM login_failures
      WHERE key = $1 AND count >= $2 AND until > now()`,
    [key, MAX_FAILURES],
  );
  const left = Number(rows[0]?.remaining_ms ?? 0);
  return left > 0 ? Math.ceil(left) : 0;
}

/**
 * 실패 한 번을 기록합니다.
 *
 * 한 문장으로 세는 이유는 **원자성** 입니다. 읽고-더하고-쓰기로 나누면 같은 순간에
 * 들어온 두 시도가 서로의 증가를 덮어씁니다. Map 이던 시절에는 노드가 단일 스레드라
 * 우연히 안전했지만, 이제는 프로세스가 여럿이라 그 우연이 사라졌습니다.
 */
export async function noteLoginFailure(key: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO login_failures (key, count, until)
     VALUES ($1, 1, now() + make_interval(mins => $2::int))
     ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN login_failures.until > now()
                         THEN login_failures.count + 1
                         ELSE 1 END,
            until = now() + make_interval(mins => $2::int),
            updated_at = now()`,
    [key, LOCK_MINUTES],
  );

  // 낡은 줄은 쓰는 김에 치웁니다 (lib/reports.ts purgeExpiredQueueReports 와 같은
  // 방식). 넉넉히 하루를 지난 것만 — 아슬아슬한 줄을 건드리지 않습니다.
  await db.query(`DELETE FROM login_failures WHERE until < now() - interval '1 day'`);
}

/** 성공했으니 카운터를 비웁니다 */
export async function clearLoginFailures(key: string): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM login_failures WHERE key = $1`, [key]);
}

/**
 * 앞에 둔 **신뢰하는** 프록시 홉 수. 기본 0 — 프록시가 없다는 뜻입니다.
 *
 * 값을 정하는 법: 클라이언트와 앱 사이에 내가 운영하는 프록시가 몇 대인가.
 * `npm run start:cluster` 는 프록시를 한 대 두므로 1 입니다(그 스크립트가
 * 자식에게 자동으로 넣어 줍니다). nginx 를 그 앞에 또 두면 2 입니다.
 */
function trustedProxyHops(): number {
  const raw = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * 시도 제한에 쓸 클라이언트 주소. **모르면 `null` 입니다.**
 *
 * ─── 왜 첫 홉을 쓰면 안 되는가 ───
 * `X-Forwarded-For` 는 클라이언트가 마음대로 보낼 수 있는 헤더입니다. 첫 값을
 * 키로 쓰면 **공격자가 잠금 키를 고르는 셈**이라, 헤더만 바꿔가며 무한히
 * 시도할 수 있습니다. 예전 구현이 그랬습니다.
 *
 * 믿을 수 있는 것은 **내가 운영하는 프록시가 오른쪽에 덧붙인 값**뿐입니다.
 * 프록시는 받은 헤더에 실제 소켓 주소를 뒤에 붙이므로, 신뢰 홉 수 N 을 알면
 * 오른쪽에서 N 번째가 진짜 클라이언트입니다.
 *
 *   보낸 값: `X-Forwarded-For: 1.2.3.4`   (위조)
 *   프록시 뒤: `1.2.3.4, 203.0.113.9`      (203.0.113.9 = 실제)
 *   N=1 → 오른쪽에서 1번째 → 203.0.113.9  ✓ 위조값은 무시됨
 *
 * ─── 프록시가 없으면(N=0) null 입니다 ───
 * 라우트 핸들러는 소켓 주소를 볼 수 없습니다(표준 `Request` 에 없습니다).
 * 그러면 클라이언트를 식별할 방법이 아예 없으므로, **틀린 키로 세는 대신
 * 안 셉니다.** 대신 로그인은 계정 단위로 셉니다 (accountKey) — 그쪽이
 * 위조가 불가능하고, 막으려는 것(한 계정 비밀번호 대입)에 정확히 걸립니다.
 */
export function clientKey(request: Request): string | null {
  const hops = trustedProxyHops();
  if (hops === 0) return null;

  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  if (chain.length >= hops) return chain[chain.length - hops] ?? null;

  // 프록시가 있다고 했는데 체인이 짧습니다 — 설정이 틀렸거나 프록시를 우회해
  // 직접 들어온 요청입니다. 둘 다 신뢰할 수 없으므로 세지 않습니다.
  return request.headers.get('x-real-ip')?.trim() || null;
}

/**
 * 계정 단위 시도 제한 키.
 *
 * IP 는 위조되고 바뀌지만 **표적 계정은 안 바뀝니다.** 비밀번호 대입을 막는
 * 자리에서는 이쪽이 근거로 더 낫습니다.
 *
 * 대소문자를 접는 이유: DB 의 닉네임 중복 차단이 `lower()` 기준이라(migrate-027)
 * 'Admin' 과 'admin' 이 같은 계정입니다. 접지 않으면 **대소문자만 바꿔가며
 * 카운터를 초기화**할 수 있습니다.
 */
export function accountKey(nickname: string): string {
  return `account:${nickname.normalize('NFC').trim().toLowerCase()}`;
}
