'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/use-session';

/**
 * 이메일 확인 결과 화면 (`/verify-email`).
 *
 * 메일의 링크는 `/api/auth/verify?token=…` 로 들어와 확인을 끝내고 여기로
 * `?status=` 만 달고 넘어옵니다 (OAuth 콜백이 `/login?error=…` 로 돌려보내는 것과
 * 같은 방식) — 토큰이 주소창·히스토리에 남지 않게 하려는 것이기도 합니다.
 *
 * status 없이 그냥 들어오는 경우도 있습니다. 가입 직후 "메일 확인해 주세요"
 * 안내를 보러 오거나, 스팸함에서 못 찾아 다시 보내러 오는 자리입니다.
 *
 * ⚠ 확인 자체는 로그인 없이 됩니다(토큰이 증명). 하지만 **다시 보내기**는
 *   로그인이 필요합니다 — 아무나 남의 주소로 메일을 쏘게 두면 이 화면이 남의
 *   메일함을 두드리는 도구가 됩니다.
 */

type Status = 'ok' | 'invalid' | 'expired' | 'used' | 'changed' | null;

/** 결과 한 줄. 무엇이 일어났는지와 **다음에 뭘 하면 되는지**를 같이 말합니다 */
const MESSAGES: Record<Exclude<Status, null>, { tone: 'ok' | 'warn'; title: string; body: string }> = {
  ok: {
    tone: 'ok',
    title: '이메일을 확인했어요',
    body: '나중에 비밀번호를 잊어도 이 주소로 되찾을 수 있어요.',
  },
  used: {
    tone: 'ok',
    title: '이미 확인한 링크예요',
    body: '이메일 확인은 이미 끝났어요. 링크는 한 번만 쓸 수 있어서 다시 열면 이 안내가 떠요.',
  },
  expired: {
    tone: 'warn',
    title: '링크 기한이 지났어요',
    body: '확인 링크는 24시간 동안만 열려요. 아래에서 새 메일을 받아 주세요.',
  },
  invalid: {
    tone: 'warn',
    title: '열 수 없는 링크예요',
    body: '주소가 잘렸거나, 새 메일을 받아서 예전 링크가 닫혔을 수 있어요. 가장 최근에 받은 메일을 열거나 아래에서 새 메일을 받아 주세요.',
  },
  changed: {
    tone: 'warn',
    title: '메일을 보낸 뒤 주소가 바뀌었어요',
    body: '이 링크는 예전 주소를 확인하는 링크라 지금 주소에는 쓸 수 없어요. 아래에서 새 메일을 받아 주세요.',
  },
};

function parseStatus(raw: string | null): Status {
  return raw !== null && raw in MESSAGES ? (raw as Status) : null;
}

export default function VerifyEmailPanel() {
  const status = parseStatus(useSearchParams().get('status'));
  const user = useSession();

  const [state, setState] = useState<{
    email: string | null;
    verified: boolean;
    mailConfigured: boolean;
    /** 이메일을 가려서 저장하는 중 — 확인 메일을 보내지 않습니다 (lib/email-mask.ts) */
    masked: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 로그인한 사람에게만 "지금 확인됐는지" 를 물어봅니다. 비로그인은 물을 대상이
  // 없고, 확인 결과(위 status)는 로그인과 무관하게 보여 줄 수 있습니다.
  useEffect(() => {
    if (!user) {
      setState(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/verify/resend', { cache: 'no-store' });
        if (!alive || !res.ok) return;
        setState(await res.json());
      } catch {
        // 상태를 못 읽어도 화면은 그립니다 — 다시 보내기 버튼이 안 보일 뿐입니다.
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, status]);

  const resend = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch('/api/auth/verify/resend', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '메일을 보내지 못했어요. 조금 뒤에 다시 시도해 주세요');
        return;
      }
      setNotice(`${data.email} 주소로 확인 메일을 보냈어요. 몇 분 안에 안 오면 스팸함도 봐 주세요.`);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const message = status ? MESSAGES[status] : null;
  const verified = state?.verified ?? status === 'ok';

  /**
   * 링크는 확인됐는데 지금 로그인한 계정은 아직 미확인 — **다른 계정의 링크**를
   * 연 것입니다 (계정을 둘 만들었거나, 남과 같은 브라우저를 쓰거나).
   * 짚어 주지 않으면 위에서는 "확인되었습니다", 아래에서는 "아직 확인 안 됨"
   * 이 같이 보여 어느 쪽이 맞는지 알 수 없습니다.
   */
  const otherAccount =
    (status === 'ok' || status === 'used') && state !== null && !state.verified;

  /** 확인 메일을 다시 받을 수 있는 사람 — 이 화면의 주 행동이 이것이 됩니다 */
  // 이메일을 가려 저장하는 동안(masked)에는 메일을 보내지 않으므로 다시 받기도 없습니다.
  const canResend = Boolean(user && state && !state.verified && state.email && !state.masked);
  /**
   * 주 버튼은 하나 (docs/DESIGN-GUIDE.md §1-2). 다시 받기 · 로그인 중 할 일이 있으면
   * 그게 주 버튼이고 '홈으로' 는 글자 링크로 낮춥니다. 할 일이 없으면(이미 확인됨)
   * 다음에 누를 것이 '홈으로' 하나라 그걸 주 버튼으로 둡니다.
   */
  const hasPrimary = canResend || !user;

  return (
    <main className="login-page">
      <section className="login-card">
        <h1>이메일 확인</h1>

        {message ? (
          <>
            <p className={message.tone === 'ok' ? 'notice' : 'warn'}>{message.title}</p>
            <p className="muted small">{message.body}</p>
          </>
        ) : state?.masked ? (
          // 보내지 않은 메일을 보냈다고 적지 않습니다 (SignupForm 머리말과 같은 이유)
          <p className="muted small">
            시험 기간에는 이메일 주소의 앞부분을 가려서 저장해서 확인 메일을 보내지
            않아요. 확인하지 않아도 둘러보기와 글쓰기는 그대로 돼요.
          </p>
        ) : (
          <p className="muted small">
            가입할 때 적은 주소로 확인 메일을 보냈어요. 메일의 링크를 열면 확인이 끝나고,
            나중에 비밀번호를 잊어도 이 주소로 되찾을 수 있어요.
          </p>
        )}

        {otherAccount && (
          <p className="muted small">
            방금 확인한 건 <strong>다른 계정</strong>의 이메일이에요. 지금 로그인한 계정
            {user ? `('${user.nickname}')` : ''}은 아직 확인 전이에요.
          </p>
        )}

        {/* 로그인한 사람에게만: 지금 주소와 다시 보내기 */}
        {user && state?.email && (
          <div className="field" style={{ marginTop: 4 }}>
            <span>{otherAccount ? '지금 로그인한 계정의 이메일' : '내 이메일'}</span>
            <p className="muted small" style={{ margin: 0 }}>
              {state.email} {verified ? '· 확인됨' : '· 아직 확인 전'}
            </p>
          </div>
        )}

        {notice && <p className="notice">{notice}</p>}
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}

        {canResend && state && !state.mailConfigured && (
          // 메일 설정은 개발자 사정이라 운영 화면에는 할 수 있는 일만 말합니다 (§6).
          <p className="muted small">
            {process.env.NODE_ENV !== 'production'
              ? '개발 모드라 메일 발송이 꺼져 있어요. 서버 콘솔에 찍힌 링크를 열어 주세요.'
              : '지금은 확인 메일을 보낼 수 없어요. 확인하지 않아도 둘러보기와 글쓰기는 그대로 돼요.'}
          </p>
        )}

        {canResend && (
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={resend}>
            {busy ? '보내는 중…' : '확인 메일 다시 받기'}
          </button>
        )}
        {!user && (
          <Link className="btn btn-primary btn-block" href="/login?next=%2Fverify-email">
            {/* 확인이 끝난 사람에게 "메일 받기" 는 할 일이 아니다 */}
            {status === 'ok' || status === 'used' ? '로그인하기' : '로그인하고 새 메일 받기'}
          </Link>
        )}
        {hasPrimary ? (
          <div className="link-row">
            <Link className="btn-link" href="/">
              홈으로 가기
            </Link>
          </div>
        ) : (
          <Link className="btn btn-primary btn-block" href="/">
            홈으로 가기
          </Link>
        )}
      </section>
    </main>
  );
}
