'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { MIN_PASSWORD_LENGTH, safeNext, type SessionUser } from '@/lib/auth-types';
import { setSession, useSession } from '@/lib/use-session';
import OAuthButtons from './OAuthButtons';
import { CONTACT_EMAIL } from '@/lib/legal';

/**
 * 회원가입 화면.
 *
 * 로그인 화면과 짝입니다 — 같은 카드, 같은 `?next=`, 끝나면 같은 자리로
 * 돌아갑니다. 서버가 가입과 동시에 세션 쿠키를 주므로(app/api/auth/signup)
 * 여기서 다시 로그인 요청을 보내지 않습니다.
 *
 * 아이디·비밀번호와 함께 **이메일**을 받습니다. 비밀번호를 잊었을 때 돌려줄
 * 길이 그것뿐이기 때문입니다. 소셜로 시작하는 사람에게는 묻지 않습니다 —
 * 아래 OAuthButtons 는 제공자 화면으로 넘어가고, 그쪽 이메일은 참고용 사본으로
 * 따로 남습니다 (lib/auth.ts linkOAuthAccount).
 *
 * 적어 낸 주소가 본인 것인지는 **아직 확인하지 않습니다.** 그래서 화면도
 * "인증 메일을 보냈습니다" 같은 말을 하지 않습니다 — 하지 않은 일을 했다고
 * 적으면 메일함을 들여다보며 기다리는 사람이 생깁니다.
 *
 * ⚠ 여기서 하는 검사는 **거들 뿐** 입니다. 판정은 서버(lib/validation.ts
 *   signupInputSchema)가 하고, 화면은 같은 규칙을 미리 보여 줄 뿐입니다.
 */

/**
 * 폼을 보내기 전에 화면에서 걸러낼 수 있는 것들. 통과해도 서버가 다시 봅니다.
 *
 * 이메일은 **모양만** 봅니다. 여기서 정규식을 깐깐하게 쓰면 실재하는 주소를
 * 틀렸다고 하게 되고, 사람은 멀쩡한 주소를 고치려 애쓰게 됩니다. 진짜 확인은
 * 인증 메일의 몫입니다.
 */
function localIssue(
  nickname: string,
  email: string,
  password: string,
  confirm: string,
): string | null {
  const name = nickname.trim();
  if (name.length < 2) return '아이디는 2자 이상이어야 합니다';
  if (name.length > 20) return '아이디는 20자까지 쓸 수 있습니다';
  if (/\s/.test(name)) return '아이디에 공백은 쓸 수 없습니다';
  const mail = email.trim();
  if (mail.length === 0) return '이메일을 입력해 주세요';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return '이메일 형식이 올바르지 않습니다';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`;
  }
  if (password !== confirm) return '비밀번호가 서로 다릅니다';
  return null;
}

export default function SignupForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const user = useSession();

  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();

    const issue = localIssue(nickname, email, password, confirm);
    if (issue) {
      setError(issue);
      return;
    }
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
        // 서버 것을 그대로 씁니다.
        setError(data.error ?? '가입에 실패했습니다');
        return;
      }

      const joined = data.user as SessionUser;
      // 가입한 이름으로 리뷰·글이 남습니다 — 플레이어는 세션에서 읽으므로
      // (lib/use-player.ts) 여기서 따로 심어 줄 값이 없습니다.
      setSession(joined);
      router.replace(next);
    } catch {
      setError('네트워크 오류');
    } finally {
      setBusy(false);
    }
  };

  // 이미 로그인한 사람에게 가입 폼을 보여 주면, 채워 넣는 동안 지금 계정이
  // 어떻게 되는지 알 수 없습니다. 무엇을 눌러야 하는지만 알려 줍니다.
  if (user) {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>이미 로그인되어 있습니다</h1>
          <p className="muted small">
            다른 계정을 만들려면 먼저 로그아웃해 주세요. 로그아웃은 로그인 화면에
            있습니다.
          </p>
          <div className="form-actions">
            <Link className="btn btn-primary btn-sm" href={next}>
              돌아가기
            </Link>
            <Link className="btn btn-sm" href={`/login?next=${encodeURIComponent(next)}`}>
              로그인 화면
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>회원가입</h1>
        <p className="muted small">
          여기서 정한 아이디가 제보·리뷰·글에 찍히는 이름이 됩니다. 이메일은 밖으로
          보이지 않고, 비밀번호를 잊었을 때 쓰입니다.
        </p>

        <label className="field">
          <span>아이디 (2~20자, 공백 없이)</span>
          <input
            autoFocus
            type="text"
            value={nickname}
            maxLength={20}
            placeholder="닉네임"
            autoComplete="username"
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>
        <label className="field">
          <span>이메일</span>
          <input
            type="email"
            value={email}
            maxLength={254}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>비밀번호 ({MIN_PASSWORD_LENGTH}자 이상)</span>
          <input
            type="password"
            value={password}
            maxLength={200}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          <span>비밀번호 확인</span>
          <input
            type="password"
            value={confirm}
            maxLength={200}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>

        <label className="consent">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            <Link href="/terms" target="_blank">
              이용약관
            </Link>
            과{' '}
            <Link href="/privacy" target="_blank">
              개인정보처리방침
            </Link>
            을 읽었고 동의합니다. 만 14세 이상입니다.
          </span>
        </label>

        {error && <p className="warn">{error}</p>}

        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              busy || !nickname.trim() || !email.trim() || !password || !confirm || !agreed
            }
          >
            {busy ? '가입 중…' : '가입하기'}
          </button>
          <Link className="btn" href={`/login?next=${encodeURIComponent(next)}`}>
            로그인
          </Link>
          <Link className="btn" href={next}>
            취소
          </Link>
        </div>

        {/* 소셜은 가입과 로그인이 같은 동작입니다 — 처음이면 계정이 생깁니다 */}
        <OAuthButtons next={next} verb="계정으로 시작" />
        <p className="muted small">
          소셜 계정으로 시작하는 것도 위 약관·처리방침에 동의하고 만 14세 이상임을 확인하는
          것입니다. 문의: {CONTACT_EMAIL}
        </p>
      </form>
    </main>
  );
}
