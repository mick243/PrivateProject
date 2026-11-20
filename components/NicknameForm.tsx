'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { safeNext, type SessionUser } from '@/lib/auth-types';
import { setSession, useSession } from '@/lib/use-session';

/**
 * 소셜 로그인 직후 **이름을 정하는 화면** (`/welcome`).
 *
 * 아이디/비밀번호로 가입하는 사람은 가입 화면에서 이름을 고릅니다. 소셜은 그
 * 화면이 없어서, 지금까지는 제공자가 준 이름을 그대로 쓰고 겹치면 뒤에 숫자를
 * 붙였습니다 — 본인이 고른 적 없는 '홍길동2' 가 제보·리뷰·글에 찍혔습니다.
 * 그래서 제공자 동의·인증이 끝나고 우리 쪽으로 돌아온 **바로 그 자리**에 한 번
 * 물어봅니다 (app/api/auth/oauth/[provider]/callback).
 *
 * 로그인은 이미 끝나 있습니다. 여기서 하는 일은 이름을 정하는 것뿐이라
 * 건너뛸 수 있고, 건너뛰면 다음 로그인에 다시 묻습니다 — 붙잡아 두는 화면이
 * 아닙니다.
 *
 * ─── 질문은 닉네임 하나 (2026-09-29) ─────────────────────────
 * 예전에는 선택 항목인 비밀번호 두 칸이 같은 카드에 있었습니다. 소셜로 막 들어온
 * 사람에게 "비밀번호도 정할래요?" 를 함께 물으면 할 일이 둘로 읽힙니다
 * (docs/DESIGN-GUIDE.md §1-2). 비밀번호는 내 정보(/account)에서 언제든 정할 수 있어
 * 여기서는 뺐습니다. 서버(app/api/auth/nickname)는 여전히 비밀번호를 받을 수 있습니다.
 *
 * ⚠ 여기서 하는 검사는 **거들 뿐** 입니다. 판정은 서버(lib/validation.ts
 *   nicknameInputSchema · lib/auth.ts claimNickname)가 합니다.
 */

/** 서버가 보는 규칙과 같은 것 (문구도 lib/validation.ts 와 같게). 통과해도 서버가 다시 봅니다 */
function localIssue(nickname: string): string | null {
  const name = nickname.trim();
  if (name.length < 2) return '닉네임은 2자 이상으로 써 주세요';
  if (name.length > 20) return '닉네임은 20자까지 쓸 수 있어요';
  if (/\s/.test(name)) return '닉네임은 띄어쓰기 없이 써 주세요';
  return null;
}

type Phase =
  /** 물어볼 상태인지 서버에 확인하는 중 */
  | { kind: 'loading' }
  /** 물어볼 상태 — 폼을 그립니다 */
  | { kind: 'ask' }
  /** 물어볼 수 없는 상태 — 로그인이 없거나, 이미 정했거나(뒤로 가기), 연결이 끊겼거나 */
  | { kind: 'done'; reason: 'login' | 'settled' | 'offline' };

export default function NicknameForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const user = useSession();

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 주소를 직접 치고 올 수도 있고, 이름을 정한 뒤 뒤로 가기로 돌아올 수도
  // 있습니다. "물어볼 상태인가" 는 세션이 아니라 서버(DB)만 압니다.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/nickname', { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 401) {
          setPhase({ kind: 'done', reason: 'login' });
          return;
        }
        const data = (await res.json()) as { nickname?: string; pending?: boolean };
        if (!alive) return;
        if (!data.pending) {
          setPhase({ kind: 'done', reason: 'settled' });
          return;
        }
        // 제공자가 준 이름을 미리 채워 둡니다 — 그대로 쓰고 싶은 사람이 대부분이고,
        // 빈 칸으로 두면 방금 본 이름과 다른 이름을 새로 지어야 하는 것처럼 보입니다.
        setNickname(data.nickname ?? '');
        setPhase({ kind: 'ask' });
      } catch {
        if (alive) setPhase({ kind: 'done', reason: 'offline' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();

    const issue = localIssue(nickname);
    if (issue) {
      setError(issue);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/nickname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 중복(409)처럼 다음에 뭘 해야 하는지가 담긴 문구는 서버 것을 그대로 씁니다.
        setError(data.error ?? '닉네임을 저장하지 못했어요. 다시 시도해 주세요');
        return;
      }

      // 세션 쿠키가 새 이름으로 다시 서명돼 왔습니다 — 상단 네비와 글 작성자가
      // 곧바로 따라오도록 스토어에도 심어 줍니다 (lib/use-session.ts).
      setSession(data.user as SessionUser);
      router.replace(next);
    } catch {
      setError('연결이 잠깐 끊겼어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  if (phase.kind === 'loading') {
    return (
      <main className="login-page">
        <p className="muted pad">불러오는 중…</p>
      </main>
    );
  }

  if (phase.kind === 'done') {
    const loginHref = `/login?next=${encodeURIComponent(next)}`;
    return (
      <main className="login-page">
        <section className="login-card">
          {phase.reason === 'login' && (
            <>
              <h1>먼저 로그인해 주세요</h1>
              <p className="muted small">로그인하면 닉네임을 정할 수 있어요.</p>
              <Link className="btn btn-primary btn-block" href={loginHref}>
                로그인하러 가기
              </Link>
            </>
          )}
          {phase.reason === 'settled' && (
            <>
              <h1>닉네임은 이미 정했어요</h1>
              {/* 이름 뒤에 조사를 붙이지 않습니다 — '…서로' 와 '…들으로' 처럼
                  받침에 따라 달라지고, 영문 이름이면 어느 쪽도 어색합니다. 그래서 따로 한 줄. */}
              {user && <p className="login-who">{user.nickname}</p>}
              <Link className="btn btn-primary btn-block" href={next}>
                보던 화면으로 돌아가기
              </Link>
              <div className="link-row">
                <Link className="btn-link" href="/account">
                  닉네임 바꾸러 가기
                </Link>
              </div>
            </>
          )}
          {phase.reason === 'offline' && (
            <>
              <h1>연결이 잠깐 끊겼어요</h1>
              <p className="muted small">새로고침하면 이어서 닉네임을 정할 수 있어요.</p>
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => window.location.reload()}
              >
                다시 시도하기
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>어떤 닉네임을 쓸까요?</h1>
        <p className="muted small">
          로그인은 끝났어요. 소셜 계정의 이름을 넣어 뒀으니 그대로 써도 돼요.
        </p>

        <label className="field">
          <span>닉네임</span>
          <input
            autoFocus
            type="text"
            value={nickname}
            maxLength={20}
            autoComplete="off"
            aria-describedby="nickname-hint"
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>
        <p id="nickname-hint" className="muted small">
          제보 · 리뷰 · 글에 이 이름이 보여요. 2~20자, 띄어쓰기 없이 써 주세요.
        </p>

        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={busy || !nickname.trim()}
        >
          {busy ? '저장하는 중…' : '이 닉네임으로 시작하기'}
        </button>
        <div className="link-row">
          {/* 건너뛰어도 로그인은 그대로입니다. 표시를 끄지 않으므로 다음 로그인에
              다시 묻습니다 — 임의로 붙인 이름을 조용히 확정하지 않으려는 것입니다. */}
          <Link className="btn-link" href={next}>
            나중에 정하기
          </Link>
        </div>
      </form>
    </main>
  );
}
