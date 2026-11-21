'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MIN_PASSWORD_LENGTH, type SessionUser } from '@/lib/auth-types';
import { setSession } from '@/lib/use-session';

/**
 * 새 비밀번호 정하기 (`/reset-password?token=…`) — 비밀번호 찾기 메일의 링크가 오는 자리.
 *
 * 1. 열자마자 링크를 쓸 수 있는지 묻습니다 (POST /api/auth/password-reset/check).
 *    다 적은 뒤에야 "기한이 지났어요" 를 듣지 않게.
 * 2. 쓸 수 있으면 새 비밀번호 두 칸. 바꾸면 이 창은 그대로 로그인됩니다
 *    (app/api/auth/password-reset/confirm).
 *
 * 토큰은 읽자마자 주소창에서 지웁니다 — 히스토리 · 공유 · Referer 에 남지 않게. 새로고침해도
 * 이어지도록 이 탭의 sessionStorage 에만 잠깐 둡니다(바꾸고 나면 지웁니다).
 */

type Check = 'checking' | 'ok' | 'invalid' | 'expired' | 'used' | 'changed';

const TOKEN_KEY = 'arcade:reset-token';

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function store(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 저장소를 못 쓰면 새로고침 때 이어지지 않을 뿐입니다.
  }
}

/** 링크를 쓸 수 없을 때 — 무슨 일 + 할 일 */
const PROBLEMS: Record<Exclude<Check, 'checking' | 'ok'>, { title: string; body: string }> = {
  invalid: {
    title: '열 수 없는 링크예요',
    body: '주소가 잘렸거나, 새 링크를 받아서 예전 링크가 닫혔을 수 있어요. 가장 최근에 받은 메일을 열거나 새 링크를 받아 주세요.',
  },
  expired: {
    title: '링크 기한이 지났어요',
    body: '비밀번호 찾기 링크는 1시간 동안만 열려요. 새 링크를 받아 주세요.',
  },
  used: {
    title: '이미 쓴 링크예요',
    body: '이 링크로 비밀번호를 이미 바꿨어요. 바꾼 비밀번호로 로그인해 주세요.',
  },
  changed: {
    title: '메일을 보낸 뒤 이메일 주소가 바뀌었어요',
    body: '이 링크는 예전 주소로 보낸 것이라 쓸 수 없어요. 새 링크를 받아 주세요.',
  },
};

export default function ResetPasswordForm() {
  const urlToken = useSearchParams().get('token');
  const [token] = useState<string | null>(() => urlToken ?? (typeof window === 'undefined' ? null : readStored()));
  const [check, setCheck] = useState<Check>('checking');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ user: SessionUser | null; suspended?: string } | null>(null);

  // 주소창에서 토큰을 지운다 (머리말)
  useEffect(() => {
    if (!urlToken) return;
    store(urlToken);
    window.history.replaceState(null, '', '/reset-password');
  }, [urlToken]);

  useEffect(() => {
    if (!token) {
      setCheck('invalid');
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/password-reset/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json()) as { status?: Check };
        if (!alive) return;
        setCheck(res.ok && data.status ? data.status : 'invalid');
      } catch {
        // 확인을 못 했으면 칸을 열어 둡니다 — 바꿀 때 서버가 다시 판정합니다.
        if (alive) setCheck('ok');
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요 (지금 ${password.length}자)`);
      return;
    }
    if (password !== confirm) {
      setError('두 비밀번호가 달라요. 다시 확인해 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, passwordConfirm: confirm }),
      });
      const data = (await res.json()) as {
        error?: string;
        reason?: Check;
        user?: SessionUser | null;
        suspended?: string;
      };
      if (!res.ok) {
        // 링크 자체가 막혔으면(409) 칸을 닫고 그 안내로 바꿉니다
        if (data.reason && data.reason in PROBLEMS) {
          store(null);
          setCheck(data.reason);
          return;
        }
        setError(data.error ?? '비밀번호를 바꾸지 못했어요. 다시 시도해 주세요');
        return;
      }
      store(null);
      if (data.user) setSession(data.user);
      setDone({ user: data.user ?? null, suspended: data.suspended });
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>비밀번호를 바꿨어요</h1>
          {done.user ? (
            <>
              <p className="notice" role="status">
                &apos;{done.user.nickname}&apos;(으)로 로그인했어요. 다른 기기의 로그인은 모두 끊었어요.
              </p>
              <Link className="btn btn-primary btn-block" href="/">
                홈으로 가기
              </Link>
            </>
          ) : (
            <>
              {done.suspended && <p className="warn">{done.suspended}</p>}
              <Link className="btn btn-primary btn-block" href="/login">
                로그인 화면으로 가기
              </Link>
            </>
          )}
        </section>
      </main>
    );
  }

  if (check === 'checking') {
    return (
      <main className="login-page">
        <p className="muted pad">링크를 확인하는 중…</p>
      </main>
    );
  }

  if (check !== 'ok') {
    const problem = PROBLEMS[check];
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>새 비밀번호 정하기</h1>
          <p className="warn">{problem.title}</p>
          <p className="muted small">{problem.body}</p>
          {check === 'used' ? (
            <Link className="btn btn-primary btn-block" href="/login">
              로그인하러 가기
            </Link>
          ) : (
            <Link className="btn btn-primary btn-block" href="/forgot-password">
              새 링크 받기
            </Link>
          )}
          <div className="link-row">
            <Link className="btn-link" href="/">
              홈으로 가기
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit} noValidate>
        <h1>새 비밀번호를 정해 주세요</h1>
        <label className="field">
          <span>새 비밀번호</span>
          <input
            autoFocus
            type="password"
            value={password}
            maxLength={200}
            autoComplete="new-password"
            aria-describedby="reset-hint"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          <span>한 번 더</span>
          <input
            type="password"
            value={confirm}
            maxLength={200}
            autoComplete="new-password"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <p id="reset-hint" className="muted small">
          {MIN_PASSWORD_LENGTH}자 이상이면 돼요. 바꾸면 다른 기기의 로그인은 모두 끊겨요.
        </p>

        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '바꾸는 중…' : '새 비밀번호로 바꾸기'}
        </button>
      </form>
    </main>
  );
}
