/**
 * 메일 발송.
 *
 * SMTP 클라이언트(nodemailer)를 넣지 않고 **HTTP API** 를 씁니다. 이 프로젝트의
 * 의존성은 pg·zod·next 정도로 얇고, 메일 한 통 보내자고 SMTP 스택을 통째로
 * 들이는 것은 값이 맞지 않습니다. Resend 의 발송 API 는 `fetch` 한 번이라
 * 패키지가 0개 늘어납니다 (lib/oauth.ts 가 next-auth 를 쓰지 않는 것과 같은
 * 판단입니다).
 *
 * 다른 제공자로 옮기더라도 이 파일 하나만 바뀝니다 — 부르는 쪽은 sendMail 의
 * 모양만 압니다.
 *
 * ⚠ 키는 서버에만 있습니다. NEXT_PUBLIC_ 접두사가 붙은 변수를 만들지 마세요 —
 *   붙는 순간 클라이언트 번들에 실려 나갑니다.
 */

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export interface Mail {
  to: string;
  subject: string;
  /** 서식 없는 본문. 이미지를 막아 둔 메일 클라이언트가 읽는 것이 이쪽입니다 */
  text: string;
  html: string;
}

function apiKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

/** 보내는 사람. 제공자에 등록·인증한 도메인이어야 실제로 나갑니다 */
function from(): string {
  return process.env.MAIL_FROM?.trim() || '오락실 파인더 <onboarding@resend.dev>';
}

export function isMailConfigured(): boolean {
  return apiKey() !== null;
}

/**
 * 한 통 보냅니다. 성공하면 true.
 *
 * **던지지 않습니다.** 부르는 쪽(가입·재발송)은 메일이 안 나갔다고 해서 하던
 * 일을 되돌릴 수 없습니다 — 계정은 이미 만들어졌고, 사용자는 다시 보내기를
 * 누르면 됩니다. 그래서 실패는 예외가 아니라 false 와 로그로 답합니다.
 *
 * 키가 없을 때:
 *   - 개발에서는 **본문을 콘솔에 찍고 성공으로 칩니다.** 인증 링크가 터미널에
 *     그대로 나오므로 메일 계정 없이 전체 흐름을 밟아 볼 수 있습니다.
 *   - 운영에서는 보내지 않고 false — 조용히 성공한 척하면 "메일이 안 와요" 의
 *     원인을 찾을 수 없게 됩니다.
 */
export async function sendMail(mail: Mail, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const key = apiKey();

  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[mail] RESEND_API_KEY 미설정 — 발송하지 않았습니다:', mail.subject);
      return false;
    }
    console.log(
      `\n[mail] (개발 모드 — 실제로 보내지 않음)\n  받는 사람: ${mail.to}\n  제목: ${mail.subject}\n${mail.text}\n`,
    );
    return true;
  }

  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: from(),
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 본문에 이유가 담겨 옵니다(도메인 미인증 등). 주소는 남기지 않습니다 —
      // 로그는 우리 것이 아닐 수 있고, 이메일은 남의 개인정보입니다.
      console.error(`[mail] 발송 실패 ${res.status} —`, (await res.text()).slice(0, 300));
    }
    return res.ok;
  } catch (err) {
    console.error('[mail] 발송 실패 —', err instanceof Error ? err.message : err);
    return false;
  }
}
