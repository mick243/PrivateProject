/**
 * 이메일을 가려서 저장하기 — 베타 시험 기간용 (2026-10-02).
 *
 * 시험에 참여한 사람의 실제 주소를 DB 에 두지 않으려고 `@` 앞부분을 가려 넣습니다.
 *
 *   pumpfan@example.com → pu*****@example.com
 *
 * 가리는 자리는 세 곳입니다 — 일반 가입의 players.email (lib/auth.ts createAccount),
 * 소셜 로그인의 참고용 사본 player_identities.email (linkOAuthAccount), 그리고 확인 메일
 * 발급 기록(email_verifications.email). 마지막은 아래 이유로 아예 생기지 않습니다.
 *
 * 무엇이 그대로이고 무엇이 멈추나:
 *   - **로그인은 그대로입니다.** 아이디(닉네임)와 비밀번호로 들어오고, 소셜은 제공자의
 *     uid 로 찾습니다. 이메일로 사람을 찾는 길은 없습니다.
 *   - **확인 메일은 못 보냅니다.** 메일은 저장된 주소로 가는데 그 주소가 가려져 있습니다.
 *     그래서 가리는 동안에는 발송을 건너뜁니다 (lib/email-verify.ts sendVerificationMail).
 *     지금 운영 주소(sslip.io)는 메일 도메인 인증을 못 해 어차피 운영자 본인에게만 갑니다.
 *   - **"이미 가입된 이메일" 을 가리지 않습니다.** 가린 값은 사람이 아니라 모양을 가리킵니다 —
 *     `pu*****@gmail.com` 은 수많은 사람의 주소입니다. 그 값으로 중복을 막으면 다른 사람의
 *     가입을 막게 됩니다.
 *
 * 스위치는 DB_FALLBACK 과 같은 모양입니다 (lib/db.ts).
 *   EMAIL_MASKING=on   → 가립니다
 *   EMAIL_MASKING=off  → 적은 그대로 둡니다
 *   (비움)             → **운영(NODE_ENV=production)에서만 on.** 개발 · 테스트는 그대로
 *
 * 값은 부를 때마다 읽습니다 — 테스트가 켜고 끌 수 있게.
 * ⚠ 켜기 전에 들어온 주소는 그대로 남습니다. 가리려면 DB 를 따로 고쳐야 합니다.
 */

/** 앞에서 이만큼은 보여 줍니다 — 본인이 "내 주소" 를 알아볼 만큼만 */
const VISIBLE_HEAD = 2;

export function isEmailMaskingOn(env: Partial<Record<string, string>> = process.env): boolean {
  const flag = env.EMAIL_MASKING?.trim().toLowerCase();
  if (flag) return flag !== 'off';
  return env.NODE_ENV === 'production';
}

/**
 * `@` 앞을 가립니다. 앞 두 글자만 남기고 나머지는 같은 개수의 `*` 로 바꿉니다.
 * 앞부분이 세 글자 이하면 한 글자만 남깁니다 — 두 글자를 남기면 거의 다 보입니다.
 * 도메인은 그대로 둡니다 (어느 제공자 주소인지는 사람을 가리키지 않습니다).
 *
 * 글자는 코드 포인트로 셉니다 — 국제화 주소의 한글 한 글자가 반으로 잘리지 않게.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = Array.from(at < 0 ? email : email.slice(0, at));
  const domain = at < 0 ? '' : email.slice(at);
  // 한 글자짜리는 그 한 글자가 곧 전부라 하나도 남기지 않습니다
  const head = local.length > 3 ? VISIBLE_HEAD : Math.max(0, Math.min(1, local.length - 1));
  return `${local.slice(0, head).join('')}${'*'.repeat(local.length - head)}${domain}`;
}

/** DB 에 넣을 값 — 가리는 중이면 가린 값, 아니면 그대로 */
export function emailForStorage(email: string): string;
export function emailForStorage(email: string | null): string | null;
export function emailForStorage(email: string | null): string | null {
  if (email === null || !isEmailMaskingOn()) return email;
  return maskEmail(email);
}
