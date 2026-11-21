'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { MIN_PASSWORD_LENGTH, safeNext, type SessionUser } from '@/lib/auth-types';
import { setSession, useSession } from '@/lib/use-session';
import OAuthButtons from './OAuthButtons';

/**
 * 회원가입 화면.
 *
 * 로그인 화면과 짝입니다 — 같은 카드, 같은 `?next=`, 끝나면 같은 자리로
 * 돌아갑니다. 서버가 가입과 동시에 세션 쿠키를 주므로(app/api/auth/signup)
 * 여기서 다시 로그인 요청을 보내지 않습니다.
 *
 * ─── 한 단계에 질문 하나 (2026-09-29) ─────────────────────────
 * 예전에는 아이디 · 이메일 · 비밀번호 · 비밀번호 확인 · 약관 동의가 한 카드에 있고,
 * 가입하기 · 로그인 · 취소 버튼이 같은 무게로 나란히 섰습니다. 지금은
 * **아이디 → 이메일 → 비밀번호 → 동의** 네 단계로 나눠 한 번에 하나만 묻습니다
 * (docs/DESIGN-GUIDE.md §1-2). 단계마다 주 버튼은 하나이고, 버튼에는 "누르면 무엇이
 * 되는지" 를 씁니다 (`이 아이디로 할게요`).
 *
 * 요청은 **마지막 단계에서 한 번만** 보냅니다. 앞 단계의 검사는 화면에서만 하고,
 * 서버가 다른 칸을 문제 삼으면(이미 있는 아이디 등) 응답의 `field` 를 보고 그 단계로
 * 되돌아가 그 자리에서 문구를 보여 줍니다.
 *
 * 아이디·비밀번호와 함께 **이메일**을 받습니다. 비밀번호를 잊었을 때 돌려줄
 * 길이 그것뿐이기 때문입니다. 소셜로 시작하는 사람에게는 묻지 않습니다 —
 * 첫 단계의 OAuthButtons 는 제공자 화면으로 넘어가고, 그쪽 이메일은 참고용 사본으로
 * 따로 남습니다 (lib/auth.ts linkOAuthAccount).
 *
 * 가입이 끝나면 **완료 화면**을 한 번 보여 줍니다 — 누구로 로그인했는지, 확인 메일이 갔는지(이메일의
 * 쓰임새), 그리고 주 버튼 하나(보던 화면 · 없으면 오락실 찾기)와 커뮤니티 링크. 예전에는 아무 말 없이
 * `next` 로 갔는데, 홈에서 가입하면 화면이 비로그인 때와 같아 가입이 됐는지 몰랐습니다 (UX 시험 A-1 · A-2).
 *
 * ⚠ 여기서 하는 검사는 **거들 뿐** 입니다. 판정은 서버(lib/validation.ts
 *   signupInputSchema)가 하고, 화면은 같은 규칙을 미리 보여 줄 뿐입니다.
 */

type Step = 0 | 1 | 2 | 3;
const STEP_COUNT = 4;

/** 서버가 문제 삼은 칸 → 돌아갈 단계 (app/api/auth/signup 의 `field`) */
const FIELD_STEP: Record<string, Step> = {
  nickname: 0,
  email: 1,
  password: 2,
  passwordConfirm: 2,
  termsAccepted: 3,
};

/*
 * 보내기 전에 화면에서 걸러낼 수 있는 것들. 통과해도 서버가 다시 봅니다.
 * 문구는 서버(lib/validation.ts)와 같은 말을 씁니다 — 같은 잘못에 두 가지 말을 하지 않게.
 */
function nicknameIssue(nickname: string): string | null {
  const name = nickname.trim();
  if (name.length < 2) return '아이디는 2자 이상으로 써 주세요';
  if (name.length > 20) return '아이디는 20자까지 쓸 수 있어요';
  if (/\s/.test(name)) return '아이디는 띄어쓰기 없이 써 주세요';
  return null;
}

/**
 * 이메일은 **모양만** 봅니다. 여기서 정규식을 깐깐하게 쓰면 실재하는 주소를
 * 틀렸다고 하게 되고, 사람은 멀쩡한 주소를 고치려 애쓰게 됩니다. 진짜 확인은
 * 인증 메일의 몫입니다.
 */
function emailIssue(email: string): string | null {
  const mail = email.trim();
  if (mail.length === 0) return '이메일을 입력해 주세요';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return '이메일 주소를 다시 확인해 주세요 (예: you@example.com)';
  }
  return null;
}

function passwordIssue(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`;
  }
  if (password !== confirm) return '두 비밀번호가 달라요. 다시 확인해 주세요';
  return null;
}

export default function SignupForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const user = useSession();

  const [step, setStep] = useState<Step>(0);
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 가입이 끝났다 — 완료 화면을 보여 줍니다 (UX 시험 A-1). 'sent' 면 확인 메일이 가는 중 */
  const [joined, setJoined] = useState<{ nickname: string; email: string; mail: 'sent' | 'off' } | null>(
    null,
  );

  const goTo = (target: Step) => {
    setError(null);
    setStep(target);
  };

  const signup = async () => {
    if (!agreed) {
      setError('이용약관과 개인정보처리방침에 동의해 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname,
          email,
          password,
          passwordConfirm: confirm,
          termsAccepted: agreed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 중복 아이디(409)·잠금(429)처럼 다음에 뭘 해야 하는지가 담긴 문구는
        // 서버 것을 그대로 씁니다. 문제가 된 칸이 앞 단계라면 그 단계로 돌아갑니다 —
        // 마지막 단계에 "이미 있는 아이디" 를 띄우면 고칠 칸이 화면에 없습니다.
        const back = typeof data.field === 'string' ? FIELD_STEP[data.field] : undefined;
        if (back !== undefined) setStep(back);
        setError(data.error ?? '가입하지 못했어요. 다시 시도해 주세요');
        return;
      }

      const user = data.user as SessionUser;
      // 가입한 이름으로 리뷰·글이 남습니다 — 플레이어는 세션에서 읽으므로
      // (lib/use-player.ts) 여기서 따로 심어 줄 값이 없습니다.
      // 곧장 돌려보내지 않고 완료 화면을 한 번 보여 줍니다. 예전에는 아무 말 없이 홈으로 가서
      // 홈이 비로그인 때와 같아 가입이 됐는지 몰랐습니다 (2026-11-20 UX 시험 A-1).
      setJoined({
        nickname: user.nickname,
        email: email.trim(),
        mail: data.emailVerification === 'off' ? 'off' : 'sent',
      });
      setSession(user);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  /** Enter 와 주 버튼이 같은 곳으로 옵니다 — 지금 단계를 검사하고 다음 단계로 */
  const submitStep = (e: React.FormEvent) => {
    e.preventDefault();
    const issue =
      step === 0
        ? nicknameIssue(nickname)
        : step === 1
          ? emailIssue(email)
          : step === 2
            ? passwordIssue(password, confirm)
            : null;
    if (issue) {
      setError(issue);
      return;
    }
    if (step < 3) {
      goTo((step + 1) as Step);
      return;
    }
    void signup();
  };

  // 가입 완료 — 세션이 생겨 아래 "이미 로그인했어요" 보다 먼저 봅니다.
  if (joined) {
    // 주 버튼은 하나: 보던 화면이 있으면 그리로, 홈에서 왔으면 오락실 찾기로 (§1-2 · §1-3)
    const back = next !== '/';
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>가입했어요!</h1>
          <p className="notice" role="status">
            &apos;{joined.nickname}&apos;(으)로 로그인했어요. 이제 글 · 댓글 · 리뷰를 남길 수 있어요.
          </p>
          <p className="muted small">
            {joined.mail === 'sent'
              ? `${joined.email}로 확인 메일을 보냈어요. 확인하지 않아도 다 쓸 수 있고, 확인해 두면 비밀번호를 잊었을 때 이 주소로 되찾을 수 있어요.`
              : '지금은 확인 메일을 보내지 않아요. 확인하지 않아도 다 쓸 수 있어요.'}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => router.replace(back ? next : '/finder')}
          >
            {back ? '보던 화면으로 돌아가기' : '오락실 찾으러 가기'}
          </button>
          <div className="link-row">
            <Link className="btn-link" href="/community">
              커뮤니티 둘러보기
            </Link>
            {back && (
              <Link className="btn-link" href="/finder">
                오락실 찾기
              </Link>
            )}
          </div>
        </section>
      </main>
    );
  }

  // 이미 로그인한 사람에게 가입 폼을 보여 주면, 채워 넣는 동안 지금 계정이
  // 어떻게 되는지 알 수 없습니다. 무엇을 눌러야 하는지만 알려 줍니다.
  if (user) {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>이미 로그인했어요</h1>
          <p className="muted small">다른 계정을 만들려면 먼저 로그아웃해 주세요.</p>
          <Link className="btn btn-primary btn-block" href={next}>
            보던 화면으로 돌아가기
          </Link>
          <div className="link-row">
            <Link className="btn-link" href={`/login?next=${encodeURIComponent(next)}`}>
              로그아웃하러 가기
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const primaryLabel = [
    '이 아이디로 할게요',
    '이 이메일로 할게요',
    '이 비밀번호로 할게요',
    busy ? '가입하는 중…' : '동의하고 가입하기',
  ][step];

  const primaryDisabled =
    busy ||
    (step === 0 && !nickname.trim()) ||
    (step === 1 && !email.trim()) ||
    (step === 2 && (!password || !confirm)) ||
    (step === 3 && !agreed);

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submitStep} noValidate>
        <div className="steps">
          <span>
            <span className="sr-only">가입 </span>
            {step + 1}/{STEP_COUNT}
          </span>
          <span className="steps-bar" aria-hidden="true">
            <span style={{ width: `${((step + 1) / STEP_COUNT) * 100}%` }} />
          </span>
        </div>

        {/* 단계마다 칸이 새로 그려지므로 autoFocus 가 매번 걸립니다 — 다음 칸으로 손이 바로 갑니다 */}
        {step === 0 && (
          <>
            <h1>어떤 아이디를 쓸까요?</h1>
            <label className="field">
              <span>아이디</span>
              <input
                autoFocus
                type="text"
                value={nickname}
                maxLength={20}
                autoComplete="username"
                aria-describedby="signup-hint"
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
            <p id="signup-hint" className="muted small">
              제보 · 리뷰 · 글에 이 이름이 보여요. 2~20자, 띄어쓰기 없이 써 주세요.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <h1>이메일을 알려 주세요</h1>
            <label className="field">
              <span>이메일</span>
              <input
                autoFocus
                type="email"
                value={email}
                maxLength={254}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                aria-describedby="signup-hint"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <p id="signup-hint" className="muted small">
              다른 사람에게는 보이지 않고, 비밀번호를 잊었을 때 쓰여요.
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <h1>비밀번호를 정해 주세요</h1>
            {/* 비밀번호 관리자가 이 비밀번호를 어느 아이디에 저장할지 알도록 — 화면에는 보이지 않습니다 */}
            <input type="text" autoComplete="username" value={nickname} readOnly hidden />
            <label className="field">
              <span>비밀번호</span>
              <input
                autoFocus
                type="password"
                value={password}
                maxLength={200}
                autoComplete="new-password"
                aria-describedby="signup-hint"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>비밀번호 한 번 더</span>
              <input
                type="password"
                value={confirm}
                maxLength={200}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <p id="signup-hint" className="muted small">
              {MIN_PASSWORD_LENGTH}자 이상이면 돼요.
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <h1>마지막으로 약관을 확인해 주세요</h1>
            {/* 무엇으로 가입하는지 한 번 보여 줍니다 — 고치려면 아래 '이전으로' */}
            <p className="muted small">
              아이디 <strong>{nickname.trim()}</strong>
              <br />
              이메일 <strong>{email.trim()}</strong>
            </p>
            <label className="consent">
              <input
                autoFocus
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>
                <Link href="/terms" target="_blank">
                  이용약관
                </Link>
                과{' '}
                <Link href="/privacy" target="_blank">
                  개인정보처리방침
                </Link>
                에 동의해요. 만 14세 이상이에요.
              </span>
            </label>
          </>
        )}

        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={primaryDisabled}>
          {primaryLabel}
        </button>

        <div className="link-row">
          {step === 0 ? (
            <>
              <Link className="btn-link" href={`/login?next=${encodeURIComponent(next)}`}>
                이미 계정이 있다면 로그인하기
              </Link>
              <Link className="btn-link" href={next}>
                나중에 가입하기
              </Link>
            </>
          ) : (
            <button
              type="button"
              className="btn-link"
              disabled={busy}
              onClick={() => goTo((step - 1) as Step)}
            >
              이전으로
            </button>
          )}
        </div>

        {/* 소셜은 가입과 로그인이 같은 동작입니다 — 처음이면 계정이 생깁니다.
            첫 단계에만 둡니다: 이미 아이디를 정하기 시작한 사람에게 다른 길을 계속 내밀지 않습니다. */}
        {step === 0 && (
          <>
            <OAuthButtons next={next} verb="시작하기" />
            <p className="muted small">
              소셜 계정으로 시작하면 <Link href="/terms">이용약관</Link>과{' '}
              <Link href="/privacy">개인정보처리방침</Link>에 동의하고 만 14세 이상인 것으로 봐요.
            </p>
          </>
        )}
      </form>
    </main>
  );
}
