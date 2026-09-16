import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db';
import { isMailConfigured, sendMail } from './mailer';

/**
 * 이메일 인증 — 적어 낸 주소의 주인이 맞는지 확인합니다.
 *
 * 흐름은 세 단계입니다.
 *   1. issueVerification()  토큰을 만들어 DB 에 **해시로** 넣고 원문을 돌려줍니다
 *   2. 메일의 링크 = `/api/auth/verify?token=<원문>`
 *   3. consumeVerification()  해시로 찾아 맞으면 players.email_verified_at 을 채웁니다
 *
 * **로그인을 막지 않습니다.** 확인 전에도 둘러보고 글을 씁니다 — 관문으로 두면
 * 메일이 늦거나 스팸함에 들어간 사람이 그 자리에서 이탈합니다. 확인이 여는 것은
 * 앞으로 붙을 **비밀번호 찾기**입니다 (db/migrate-051 의 부분 UNIQUE 가 그
 * 전제입니다 — 확인된 주소는 계정 하나를 가리킵니다).
 *
 * ⚠ 토큰 원문은 DB 에 없습니다. 사용자가 링크를 잃어버리면 다시 보내는 수밖에
 *   없고, 그게 맞습니다 — 우리가 꺼내 줄 수 있으면 새어 나갈 수도 있습니다.
 */

/** 링크가 살아 있는 시간. 메일함을 하루에 한 번은 연다는 전제입니다 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 연달아 누르는 것을 막는 최소 간격 */
const RESEND_GAP_MS = 60 * 1000;
/** 한 시간에 이만큼까지. 남의 메일함을 두드리는 도구가 되지 않게 */
const RESEND_MAX_PER_HOUR = 5;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ─── 발급 ────────────────────────────────────────────────────

export type IssueResult =
  | { ok: true; token: string; email: string }
  | { ok: false; reason: 'no-email' | 'already-verified' | 'gone' | 'too-soon'; retryAfterS?: number };

/**
 * 토큰 한 장을 발급합니다. 원문은 **여기서만** 볼 수 있습니다.
 *
 * 이전에 보낸 미사용 토큰은 함께 버립니다. 남겨 두면 메일함에 살아 있는 링크가
 * 여러 장 쌓이고, "다시 보내기" 를 눌러 새 링크를 받은 사람이 옛 메일을 열어도
 * 통해 버립니다 — 무효화가 필요할 때 무엇을 지워야 하는지도 흐려집니다.
 *
 * `skipThrottle` 은 가입 직후의 첫 발송입니다. 그 순간은 아직 보낸 적이 없어
 * 어차피 통과하지만, 의도를 코드에 적어 둡니다.
 */
export async function issueVerification(
  playerId: number,
  options: { skipThrottle?: boolean } = {},
): Promise<IssueResult> {
  const db = await getDb();

  const { rows } = await db.query<{ email: string | null; email_verified_at: Date | null }>(
    `SELECT email, email_verified_at FROM players WHERE id = $1`,
    [playerId],
  );
  const player = rows[0];
  if (!player) return { ok: false, reason: 'gone' };
  if (!player.email) return { ok: false, reason: 'no-email' };
  if (player.email_verified_at) return { ok: false, reason: 'already-verified' };

  if (!options.skipThrottle) {
    const throttled = await throttleCheck(playerId);
    if (throttled) return throttled;
  }

  const token = randomBytes(32).toString('base64url');

  await db.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM email_verifications WHERE player_id = $1 AND used_at IS NULL`,
      [playerId],
    );
    await tx.query(
      `INSERT INTO email_verifications (token_hash, player_id, email, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hash(token), playerId, player.email, new Date(Date.now() + TTL_MS)],
    );
  });

  return { ok: true, token, email: player.email };
}

/**
 * 너무 잦은 재발송인가.
 *
 * 표를 따로 두지 않고 발급 이력을 그대로 셉니다 — 프로세스 메모리에 두면
 * 재시작으로 풀리고 서버가 여러 대면 대수만큼 여유가 생깁니다(lib/auth.ts 의
 * 로그인 시도 제한이 지금 그 상태입니다). 여기서는 어차피 DB 에 쓰는 김에
 * 같은 자리에서 셉니다.
 */
async function throttleCheck(
  playerId: number,
): Promise<{ ok: false; reason: 'too-soon'; retryAfterS: number } | null> {
  const db = await getDb();
  const { rows } = await db.query<{ last_at: Date | null; hour_count: string }>(
    `SELECT max(created_at) AS last_at,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour_count
       FROM email_verifications
      WHERE player_id = $1`,
    [playerId],
  );

  const lastAt = rows[0]?.last_at ? new Date(rows[0].last_at).getTime() : 0;
  const sinceLast = Date.now() - lastAt;
  if (lastAt && sinceLast < RESEND_GAP_MS) {
    return { ok: false, reason: 'too-soon', retryAfterS: Math.ceil((RESEND_GAP_MS - sinceLast) / 1000) };
  }

  if (Number(rows[0]?.hour_count ?? 0) >= RESEND_MAX_PER_HOUR) {
    // 시간 제한에 걸리면 남은 시간을 정확히 세지 않고 한 시간을 부릅니다 —
    // 정확히 알려 줘 봐야 그 시각에 맞춰 다시 두드리는 데만 쓰입니다.
    return { ok: false, reason: 'too-soon', retryAfterS: 60 * 60 };
  }

  return null;
}

// ─── 확인 ────────────────────────────────────────────────────

export type ConsumeResult =
  /** 확인 완료. 이미 확인된 계정이 같은 링크를 다시 열어도 여기로 옵니다 */
  | 'ok'
  /** 그런 토큰이 없다 (오타·위조·이미 새 링크를 받아 버려진 옛 토큰) */
  | 'invalid'
  | 'expired'
  | 'used'
  /** 보낸 뒤 주소가 바뀌었다 — 옛 링크로 새 주소를 확인해 주면 안 됩니다 */
  | 'changed';

/**
 * 링크를 받아 확인 도장을 찍습니다.
 *
 * 로그인을 요구하지 않습니다. 메일은 다른 기기·다른 브라우저에서 열리는 것이
 * 보통이고, 링크를 여는 사람이 그 메일함의 주인이라는 것 자체가 증명입니다.
 */
export async function consumeVerification(token: string): Promise<ConsumeResult> {
  const db = await getDb();

  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{
      player_id: number;
      email: string;
      expires_at: Date;
      used_at: Date | null;
      current_email: string | null;
      verified_at: Date | null;
    }>(
      `SELECT v.player_id, v.email, v.expires_at, v.used_at,
              p.email AS current_email, p.email_verified_at AS verified_at
         FROM email_verifications v
         JOIN players p ON p.id = v.player_id
        WHERE v.token_hash = $1`,
      [hash(token)],
    );

    const row = rows[0];
    if (!row) return 'invalid';
    if (row.used_at) return 'used';
    if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
    // 보낸 시점의 주소와 지금 주소가 다르면, 이 링크가 보증하는 것은 지금 주소가
    // 아닙니다. 대소문자는 저장 단계에서 이미 맞춰져 있습니다(emailField).
    if (row.current_email !== row.email) return 'changed';

    await tx.query(
      `UPDATE players SET email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1`,
      [row.player_id],
    );
    await tx.query(
      `UPDATE email_verifications SET used_at = now() WHERE token_hash = $1`,
      [hash(token)],
    );
    return 'ok';
  });
}

/** 지금 확인된 계정인가 — 화면이 배너를 그릴지 정하는 근거 */
export async function verificationStatus(
  playerId: number,
): Promise<{ email: string | null; verified: boolean } | null> {
  const db = await getDb();
  const { rows } = await db.query<{ email: string | null; email_verified_at: Date | null }>(
    `SELECT email, email_verified_at FROM players WHERE id = $1`,
    [playerId],
  );
  if (!rows[0]) return null;
  return { email: rows[0].email, verified: rows[0].email_verified_at !== null };
}

// ─── 메일 한 통 ──────────────────────────────────────────────

export type SendResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason: 'no-email' | 'already-verified' | 'gone' | 'too-soon' | 'send-failed';
      retryAfterS?: number;
    };

/**
 * 발급 + 발송을 묶습니다. 부르는 쪽(가입·재발송)이 토큰을 만질 일이 없습니다.
 *
 * `throttle` 은 사용자가 직접 누른 재발송에만 켭니다. 가입 직후의 첫 통은 아직
 * 보낸 적이 없어 어차피 통과하지만, 의도를 인자로 적어 둡니다.
 *
 * **가입 응답을 붙잡지 마세요.** 메일 API 가 느리거나 죽으면 가입이 통째로
 * 실패합니다. 라우트에서 `after()` 로 감싸 응답을 먼저 보내고 이걸 뒤에서
 * 돌립니다 (재발송은 반대 — 사용자가 결과를 보고 있으므로 기다립니다).
 */
export async function sendVerificationMail(
  playerId: number,
  baseUrl: string,
  options: { throttle?: boolean } = {},
): Promise<SendResult> {
  const issued = await issueVerification(playerId, { skipThrottle: !options.throttle });
  if (!issued.ok) return { ok: false, reason: issued.reason, retryAfterS: issued.retryAfterS };

  const base = baseUrl.replace(/\/+$/, '');
  const link = `${base}/api/auth/verify?token=${encodeURIComponent(issued.token)}`;

  const sent = await sendMail({
    to: issued.email,
    subject: '[오락실 파인더] 이메일 주소를 확인해 주세요',
    text: [
      '오락실 파인더 가입을 환영합니다.',
      '',
      '아래 주소를 열면 이메일 확인이 끝납니다. 24시간 동안 유효합니다.',
      link,
      '',
      '본인이 가입한 것이 아니라면 이 메일을 버리시면 됩니다 — 확인하지 않은 주소로는 아무 일도 일어나지 않습니다.',
    ].join('\n'),
    html: verificationHtml(link),
  });

  return sent ? { ok: true, email: issued.email } : { ok: false, reason: 'send-failed' };
}

/**
 * 메일 본문.
 *
 * 인라인 스타일만 씁니다 — 메일 클라이언트는 `<style>` 블록과 외부 CSS 를
 * 제각각으로 버립니다. 이미지도 넣지 않습니다(대개 차단되고, 차단되면 본문이
 * 사라집니다). 링크를 글자로도 적어 두는 이유는 버튼이 안 눌리는 환경이 있어서입니다.
 */
function verificationHtml(link: string): string {
  return `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;line-height:1.7;color:#1a172a;max-width:520px">
  <h2 style="font-size:20px;margin:0 0 16px">이메일 주소를 확인해 주세요</h2>
  <p style="margin:0 0 20px">오락실 파인더 가입을 환영합니다. 아래 버튼을 누르면 확인이 끝납니다.</p>
  <p style="margin:0 0 20px">
    <a href="${link}" style="display:inline-block;background:#5b3fd9;color:#fff;text-decoration:none;padding:11px 20px;border-radius:4px;font-weight:700">이메일 확인하기</a>
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#4a4560">버튼이 눌리지 않으면 아래 주소를 복사해 주소창에 붙여 넣어 주세요.</p>
  <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${link}" style="color:#5b3fd9">${link}</a></p>
  <p style="margin:0;font-size:13px;color:#6e687f">링크는 24시간 동안 유효합니다. 본인이 가입한 것이 아니라면 이 메일을 버리시면 됩니다 — 확인하지 않은 주소로는 아무 일도 일어나지 않습니다.</p>
</div>`;
}

export { isMailConfigured };
