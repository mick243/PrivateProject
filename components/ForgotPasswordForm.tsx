'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { safeNext } from '@/lib/auth-types';

/**
 * 비밀번호 찾기 화면 (`/forgot-password`).
 *
 * 아이디나 이메일 하나를 받아 링크 메일을 요청합니다 (app/api/auth/password-reset).
 * 서버는 계정이 있든 없든 같은 답을 하므로, 끝난 화면도 **"그런 계정이면 메일이 가요"** 로
 * 한 가지입니다 — 여기서 "보냈어요" 라고 단정하면 그게 곧 계정이 있다는 답이 됩니다.
 *
 * 메일을 보낼 수 없는 때(운영 메일 설정 없음 · 이메일 가림 기간)에는 칸을 열지 않고
 * 문의 주소를 보여 줍니다 — 보내지 않을 메일을 기다리게 하지 않습니다.
 *
 * `?id=` 는 로그인 화면에서 적던 아이디입니다. 다시 치지 않게 채워 둡니다 (§1-3).
 */

type Availability = { available: boolean; contactEmail: string | null } | null;

export default function ForgotPasswordForm() {
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const loginHref = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;

  const [availability, setAvailability] = useState<Availability>(null);
  const [identifier, setIdentifier] = useState(() => params.get('id')?.slice(0, 254) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/password-reset', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { available: boolean; contactEmail: string | null };
        if (alive) setAvailability(data);
      } catch {
        // 상태를 못 읽었으면 칸을 열어 둡니다 — 보낼 때 서버가 다시 판정합니다.
        if (alive) setAvailability({ available: true, contactEmail: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError('아이디나 이메일을 입력해 주세요');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        if (res.status === 503) setAvailability((a) => ({ available: false, contactEmail: a?.contactEmail ?? null }));
        setError(data.error ?? '요청하지 못했어요. 다시 시도해 주세요');
        return;
      }
      setDone(true);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  if (availability === null) {
    return (
      <main className="login-page">
        <p className="muted pad">불러오는 중…</p>
      </main>
    );
  }

  if (!availability.available) {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>비밀번호 찾기</h1>
          <p className="muted small">
            지금은 메일로 비밀번호를 찾을 수 없어요.
            {availability.contactEmail ? ' 아래 주소로 아이디를 적어 보내 주면 도와드릴게요.' : ' 조금 뒤에 다시 시도해 주세요.'}
          </p>
          {availability.contactEmail ? (
            <a
              className="btn btn-primary btn-block"
              href={`mailto:${availability.contactEmail}?subject=${encodeURIComponent('[오락실 파인더] 비밀번호 찾기')}`}
            >
              {availability.contactEmail}로 메일 쓰기
            </a>
          ) : (
            <Link className="btn btn-primary btn-block" href={loginHref}>
              로그인 화면으로 가기
            </Link>
          )}
          {availability.contactEmail && (
            <div className="link-row">
              <Link className="btn-link" href={loginHref}>
                로그인 화면으로 가기
              </Link>
            </div>
          )}
        </section>
      </main>
    );
  }

  if (done) {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>메일함을 확인해 주세요</h1>
          <p className="notice" role="status">
            &apos;{identifier.trim()}&apos;에 확인을 마친 이메일이 있으면 몇 분 안에 링크가 가요.
          </p>
          <p className="muted small">
            링크는 1시간 동안 열려요. 메일이 안 오면 스팸함을 봐 주세요. 이메일 확인을 하지 않은
            계정에는 메일이 가지 않아요.
          </p>
          <Link className="btn btn-primary btn-block" href={loginHref}>
            로그인 화면으로 가기
          </Link>
          <div className="link-row">
            <button type="button" className="btn-link" onClick={() => setDone(false)}>
              다른 아이디로 다시 받기
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit} noValidate>
        <h1>비밀번호를 잊었나요?</h1>
        <label className="field">
          <span>아이디나 이메일</span>
          <input
            autoFocus
            type="text"
            value={identifier}
            maxLength={254}
            autoComplete="username"
            aria-describedby="forgot-hint"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </label>
        <p id="forgot-hint" className="muted small">
          가입할 때 적고 확인을 마친 이메일로 새 비밀번호를 정하는 링크를 보내 드려요.
        </p>

        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '보내는 중…' : '링크 메일 받기'}
        </button>
        <div className="link-row">
          <Link className="btn-link" href={loginHref}>
            로그인 화면으로 돌아가기
          </Link>
        </div>
      </form>
    </main>
  );
}
