import { createHash, randomBytes } from 'node:crypto';
import { accountKey, clearLoginFailures, hashPassword } from './auth';
import { isEmailMaskingOn } from './email-mask';
import { isMailConfigured, sendMail } from './mailer';
import { getPrismaClient, TX_OPTIONS } from './prisma';

/**
 * 비밀번호 찾기 — 확인된 이메일로 1회용 링크를 보내 새 비밀번호를 정하게 합니다.
 *
 * 2026-11-20 UX 시험 A-3: 가입 화면은 이메일이 "비밀번호를 잊었을 때 쓰여요" 라고 했지만
 * 그 길이 없었습니다. 모양은 이메일 인증(lib/email-verify.ts)과 같습니다.
 *
 *   1. requestPasswordReset()  아이디나 이메일 → **확인된 이메일**이 있는 계정이면 메일 한 통
 *   2. 메일의 링크 = `/reset-password?token=<원문>` (화면 — 새 비밀번호를 받아야 하므로)
 *   3. consumePasswordReset()  해시로 찾아 맞으면 비밀번호를 바꾸고 세대 번호를 올립니다
 *      (token_epoch + 1 — 다른 기기의 로그인이 모두 끊깁니다, GUIDELINES §4-3)
 *
 * ─── 왜 **확인된** 이메일만인가 ───
 * 확인 전 주소는 아무나 적어 낼 수 있습니다(migrate-051 머리말). 그 주소로 링크를 보내면
 * 남의 주소를 적어 가입한 사람이 아니라 **그 주소의 주인**이 계정을 가져가게 되고, 반대로
 * 남의 계정에 내 주소를 적을 방법이 있다면 그 계정을 가져갈 수 있습니다. 확인된 주소는
 * 부분 UNIQUE(players_email_verified_lower_idx) 덕에 계정 하나만 가리킵니다.
 *
 * ─── 계정이 있는지 밖에서 알 수 없게 ───
 * 요청 라우트는 계정이 있든 없든 **같은 답**을 하고, 찾기·발송은 응답을 보낸 뒤
 * (`after()`) 돌립니다 — 답의 내용뿐 아니라 걸린 시간으로도 갈리지 않게.
 *
 * 관리자 계정은 대상이 아닙니다 — 그 비밀번호는 .env 의 ADMIN_PASSWORD 가 정본이라
 * (lib/auth.ts ensureAdminAccount) 여기서 바꿔도 다음 로그인 때 되돌아갑니다.
 */

/** 링크가 살아 있는 시간. 계정을 통째로 넘기는 링크라 인증 메일(24시간)보다 짧게 */
export const RESET_TTL_MS = 60 * 60 * 1000;
/** 같은 계정에 연달아 보내지 않는 최소 간격 */
const RESEND_GAP_MS = 60 * 1000;
/** 한 계정에 한 시간에 이만큼까지 — 남의 메일함을 두드리는 도구가 되지 않게 */
const RESEND_MAX_PER_HOUR = 5;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 지금 메일로 비밀번호를 찾을 수 있는가.
 *
 * - 이메일을 가려서 저장하는 동안(lib/email-mask.ts)은 보낼 주소가 없습니다.
 * - 운영에서 메일 키가 없으면 보내지 못합니다. 개발에서는 sendMail 이 본문(링크)을
 *   콘솔에 찍어 주므로 키 없이도 흐름을 밟을 수 있습니다.
 */
export function isPasswordResetAvailable(env: Partial<Record<string, string>> = process.env): boolean {
  if (isEmailMaskingOn(env)) return false;
  if (env.NODE_ENV === 'production' && !isMailConfigured()) return false;
  return true;
}

/** 시도 제한 · 찾기에 쓰는 정규형 — 대소문자 · 앞뒤 공백 · NFC 를 접습니다 (GUIDELINES §5) */
export function normalizeIdentifier(raw: string): string {
  return raw.normalize('NFC').trim().toLowerCase();
}

/**
 * 아이디나 이메일로 대상 계정을 찾습니다. 확인된 이메일이 없으면 null.
 * `@` 가 있으면 먼저 이메일로 찾고, 없으면(또는 `@` 가 없으면) 아이디로 찾습니다 —
 * 아이디에 `@` 가 들어간 계정도 있을 수 있어서입니다.
 */
async function findTarget(identifier: string): Promise<{ id: number; email: string } | null> {
  const prisma = await getPrismaClient();
  const key = normalizeIdentifier(identifier);
  if (!key) return null;

  if (key.includes('@')) {
    // 이메일은 저장할 때 소문자로 맞춥니다 (lib/validation.ts emailField)
    const byEmail = await prisma.players.findFirst({
      where: { email: key, email_verified_at: { not: null }, is_admin: false },
      select: { id: true, email: true },
    });
    if (byEmail?.email) return { id: byEmail.id, email: byEmail.email };
  }

  const byName = await prisma.players.findFirst({
    where: { nickname: { equals: identifier.normalize('NFC').trim(), mode: 'insensitive' }, is_admin: false },
    select: { id: true, email: true, email_verified_at: true },
  });
  if (!byName?.email || !byName.email_verified_at) return null;
  return { id: byName.id, email: byName.email };
}

/** 너무 잦은가 — 발급 이력을 그대로 셉니다 (lib/email-verify.ts throttleCheck 와 같은 방식) */
async function tooSoon(playerId: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const [latest, hourCount] = await Promise.all([
    prisma.password_resets.aggregate({
      where: { player_id: playerId },
      _max: { created_at: true },
    }),
    prisma.password_resets.count({
      where: { player_id: playerId, created_at: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    }),
  ]);
  const lastAt = latest._max.created_at ? latest._max.created_at.getTime() : 0;
  if (lastAt && Date.now() - lastAt < RESEND_GAP_MS) return true;
  return hourCount >= RESEND_MAX_PER_HOUR;
}

/**
 * 토큰 한 장을 발급합니다. 원문은 여기서만 볼 수 있습니다.
 * 이전에 보낸 미사용 링크는 함께 버립니다 — 가장 최근 메일 하나만 통하게.
 */
export async function issuePasswordReset(playerId: number, email: string): Promise<string> {
  const prisma = await getPrismaClient();
  const token = randomBytes(32).toString('base64url');
  await prisma.$transaction(async (tx) => {
    await tx.password_resets.deleteMany({ where: { player_id: playerId, used_at: null } });
    await tx.password_resets.create({
      data: {
        token_hash: hash(token),
        player_id: playerId,
        email,
        expires_at: new Date(Date.now() + RESET_TTL_MS),
      },
    });
  }, TX_OPTIONS);
  return token;
}

/** 무슨 일이 있었는지 — **로그와 테스트용**. 라우트는 이 값을 사용자에게 돌려주지 않습니다 */
export type RequestOutcome = 'sent' | 'no-target' | 'too-soon' | 'send-failed' | 'unavailable';

/**
 * 찾기 → 발급 → 발송. 라우트가 응답을 보낸 뒤(`after()`) 부릅니다.
 * 던지지 않고 결과만 돌려줍니다 (sendMail 과 같은 이유 — 부르는 쪽이 되돌릴 일이 없습니다).
 */
export async function requestPasswordReset(identifier: string, baseUrl: string): Promise<RequestOutcome> {
  if (!isPasswordResetAvailable()) return 'unavailable';

  const target = await findTarget(identifier);
  if (!target) return 'no-target';
  if (await tooSoon(target.id)) return 'too-soon';

  const token = await issuePasswordReset(target.id, target.email);
  const link = `${baseUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;

  const sent = await sendMail({
    to: target.email,
    subject: '[오락실 파인더] 비밀번호를 새로 정해 주세요',
    // 텍스트판과 HTML판(resetHtml)은 같은 내용입니다 — 한쪽만 고치지 마세요.
    text: [
      '비밀번호를 잊었다는 요청을 받았어요.',
      '',
      '아래 주소를 열면 새 비밀번호를 정할 수 있어요.',
      link,
      '',
      '링크는 1시간 동안 한 번만 쓸 수 있어요.',
      '직접 요청하지 않았다면 이 메일은 무시해도 돼요. 비밀번호는 그대로예요.',
    ].join('\n'),
    html: resetHtml(link),
  });
  return sent ? 'sent' : 'send-failed';
}

/** 메일 본문 — 인라인 스타일만 (lib/email-verify.ts verificationHtml 과 같은 이유) */
function resetHtml(link: string): string {
  return `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;line-height:1.7;color:#1a172a;max-width:520px">
  <h2 style="font-size:20px;margin:0 0 16px">비밀번호를 새로 정해 주세요</h2>
  <p style="margin:0 0 20px">비밀번호를 잊었다는 요청을 받았어요. 아래 버튼을 누르면 새 비밀번호를 정할 수 있어요.</p>
  <p style="margin:0 0 20px">
    <a href="${link}" style="display:inline-block;background:#5b3fd9;color:#fff;text-decoration:none;padding:11px 20px;border-radius:4px;font-weight:700">새 비밀번호 정하기</a>
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#4a4560">버튼이 눌리지 않으면 아래 주소를 복사해 주소창에 붙여 넣어 주세요.</p>
  <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${link}" style="color:#5b3fd9">${link}</a></p>
  <p style="margin:0;font-size:13px;color:#6e687f">링크는 1시간 동안 한 번만 쓸 수 있어요. 직접 요청하지 않았다면 이 메일은 무시해도 돼요. 비밀번호는 그대로예요.</p>
</div>`;
}

// ─── 링크 확인 · 사용 ────────────────────────────────────────

export type ResetCheck =
  | 'ok'
  /** 그런 토큰이 없다 (잘림 · 위조 · 새 링크를 받아 버려진 옛 링크) */
  | 'invalid'
  | 'expired'
  | 'used'
  /** 보낸 뒤 주소가 바뀌었거나 확인이 풀렸다 — 옛 링크가 지금 주소를 보증하지 않는다 */
  | 'changed';

interface ResetRow {
  player_id: number;
  email: string;
  expires_at: Date;
  used_at: Date | null;
  players: { email: string | null; email_verified_at: Date | null; is_admin: boolean | null; nickname: string };
}

function judge(row: ResetRow | null): ResetCheck {
  if (!row) return 'invalid';
  if (row.used_at) return 'used';
  if (row.expires_at.getTime() <= Date.now()) return 'expired';
  if (row.players.email !== row.email || !row.players.email_verified_at || row.players.is_admin) {
    return 'changed';
  }
  return 'ok';
}

const ROW_SELECT = {
  player_id: true,
  email: true,
  expires_at: true,
  used_at: true,
  players: { select: { email: true, email_verified_at: true, is_admin: true, nickname: true } },
} as const;

/** 링크가 지금 쓸 수 있는가 — 화면이 새 비밀번호 칸을 열기 전에 묻습니다. 쓰지 않습니다 */
export async function checkPasswordReset(token: string): Promise<ResetCheck> {
  const prisma = await getPrismaClient();
  const row = await prisma.password_resets.findUnique({
    where: { token_hash: hash(token) },
    select: ROW_SELECT,
  });
  return judge(row);
}

export type ConsumeResetResult =
  | { ok: true; playerId: number; nickname: string }
  | { ok: false; reason: Exclude<ResetCheck, 'ok'> };

/**
 * 링크로 새 비밀번호를 정합니다.
 *
 * 한 트랜잭션에서: 판정 → 비밀번호 · 세대 번호 → 링크 사용 표시 → 남은 미사용 링크 버리기.
 * 해시는 트랜잭션 **밖에서** 먼저 만듭니다 — scrypt 시간 동안 트랜잭션을 붙잡지 않게.
 * 끝나면 그 계정의 로그인 잠금도 풉니다(비밀번호를 잊어 여러 번 틀렸을 사람입니다).
 */
export async function consumePasswordReset(token: string, newPassword: string): Promise<ConsumeResetResult> {
  const prisma = await getPrismaClient();
  const tokenHash = hash(token);
  const passwordHash = await hashPassword(newPassword);

  const result = await prisma.$transaction(async (tx): Promise<ConsumeResetResult> => {
    const row = await tx.password_resets.findUnique({ where: { token_hash: tokenHash }, select: ROW_SELECT });
    const verdict = judge(row);
    if (verdict !== 'ok' || !row) return { ok: false, reason: verdict === 'ok' ? 'invalid' : verdict };

    await tx.players.update({
      where: { id: row.player_id },
      data: { password_hash: passwordHash, token_epoch: { increment: 1 } },
    });
    await tx.password_resets.update({ where: { token_hash: tokenHash }, data: { used_at: new Date() } });
    await tx.password_resets.deleteMany({ where: { player_id: row.player_id, used_at: null } });
    return { ok: true, playerId: row.player_id, nickname: row.players.nickname };
  }, TX_OPTIONS);

  if (result.ok) await clearLoginFailures(accountKey(result.nickname));
  return result;
}
