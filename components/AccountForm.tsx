'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MIN_PASSWORD_LENGTH, safeNext, type SessionUser } from '@/lib/auth-types';
import { setSession, useIsAdmin } from '@/lib/use-session';

/**
 * 개인정보 수정 화면 (`/account`).
 *
 * 닉네임은 제보·리뷰·글·댓글에 찍히는 이름이라, 세션 쿠키만 믿고 바꿔 주지
 * 않습니다 — **비밀번호를 다시 물어** 본인임을 확인하고 들어옵니다
 * (app/api/account/verify). 소셜로만 가입해 비밀번호가 없는 계정은 대조할 것이
 * 없으므로 검증 없이 들어오되, 저장할 때 비밀번호를 함께 정하게 합니다.
 *
 * ⚠ 여기서 하는 검사는 거들 뿐 — 판정은 서버(lib/validation.ts
 *   accountUpdateSchema · app/api/account)가 합니다.
 */

/** /welcome 과 같은 닉네임 규칙. 통과해도 서버가 다시 봅니다 */
function nicknameIssue(nickname: string): string | null {
  const name = nickname.trim();
  if (name.length < 2) return '닉네임은 2자 이상이어야 합니다';
  if (name.length > 20) return '닉네임은 20자까지 쓸 수 있습니다';
  if (/\s/.test(name)) return '닉네임에 공백은 쓸 수 없습니다';
  return null;
}

type Phase =
  /** 계정 상태(비밀번호 유무)를 서버에 묻는 중 */
  | { kind: 'loading' }
  /** 로그인이 없다 */
  | { kind: 'anonymous' }
  /** 비밀번호가 있는 계정 — 입장 전 확인 */
  | { kind: 'gate' }
  /** 수정 폼. verified 비밀번호는 저장 요청의 본인 확인에 다시 들어갑니다 */
  | { kind: 'edit'; currentPassword: string | null; hasPassword: boolean };

/**
 * /account 의 관리자 칸. 본인 확인(gate) 앞뒤 어디서나 보입니다 — 여기는 링크 하나라
 * 비밀번호를 다시 물을 이유가 없고, 관리 페이지 자체가 서버에서 다시 판정합니다
 * (app/api/emoticons/admin requireAdmin). 이 조건을 뚫고 들어가도 목록은 받지 못합니다.
 */
function AdminTools() {
  return (
    <section className="account-section account-admin">
      <h2>관리자 도구</h2>
      <p className="muted small">
        댓글·리뷰·채보 평가에서 고를 수 있는 그림 이모티콘을 등록하고, 빼고, 되살립니다.
      </p>
      <div className="form-actions">
        <Link className="btn btn-sm" href="/admin/emoticons">
          이모티콘 관리
        </Link>
      </div>
    </section>
  );
}

export default function AccountForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const isAdmin = useIsAdmin();

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [nickname, setNickname] = useState('');
  const [gatePassword, setGatePassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/account', { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 401) {
          setPhase({ kind: 'anonymous' });
          return;
        }
        const data = (await res.json()) as { nickname: string; hasPassword: boolean };
        if (!alive) return;
        setNickname(data.nickname);
        // 비밀번호가 없으면 대조할 것이 없으므로 곧장 수정 폼으로 — 대신
        // 저장하려면 비밀번호를 함께 정해야 합니다 (아래 submit).
        setPhase(
          data.hasPassword
            ? { kind: 'gate' }
            : { kind: 'edit', currentPassword: null, hasPassword: false },
        );
      } catch {
        if (alive) setPhase({ kind: 'anonymous' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: gatePassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '확인에 실패했습니다');
        return;
      }
      setPhase({ kind: 'edit', currentPassword: gatePassword, hasPassword: true });
    } catch {
      setError('네트워크 오류');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.kind !== 'edit') return;

    const issue = nicknameIssue(nickname);
    if (issue) {
      setError(issue);
      return;
    }
    // 비밀번호가 없는 계정은 여기서 첫 비밀번호를 반드시 정합니다 — 그래야
    // 다음부터 이 화면의 입장 검증이 성립합니다.
    if (!phase.hasPassword && newPassword.length === 0) {
      setError('비밀번호를 설정해 주세요');
      return;
    }
    if (newPassword.length > 0) {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`);
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        setError('비밀번호가 서로 다릅니다');
        return;
      }
    }

    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: phase.currentPassword ?? undefined,
          nickname,
          newPassword: newPassword || undefined,
          newPasswordConfirm: newPassword ? newPasswordConfirm : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '저장하지 못했습니다');
        return;
      }

      // 세션 쿠키가 새 이름으로 다시 서명돼 왔습니다 — 상단 네비가 곧바로
      // 따라오도록 스토어에도 심어 줍니다 (/welcome 과 같은 처리).
      setSession(data.user as SessionUser);
      setSaved(true);
      // 방금 정한 비밀번호가 다음 저장의 본인 확인 값이 됩니다.
      const password = newPassword || phase.currentPassword;
      setPhase({ kind: 'edit', currentPassword: password, hasPassword: true });
      setNewPassword('');
      setNewPasswordConfirm('');
    } catch {
      setError('네트워크 오류');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 다른 기기에서 모두 로그아웃.
   *
   * 세션 쿠키는 서명만으로 성립해서 "내 브라우저에서 로그아웃" 은 남의 기기에
   * 열려 있는 창에 아무 영향이 없었습니다. 이 버튼이 계정의 세대 번호를 올려
   * 지난 쿠키를 한꺼번에 무효로 만듭니다 (app/api/account/sessions).
   * 지금 이 창은 새 쿠키를 받아 오므로 로그인 상태 그대로입니다.
   */
  const revokeOthers = async () => {
    const ok = window.confirm(
      '다른 기기·브라우저에 남아 있는 로그인을 모두 끊을까요?\n지금 이 창은 그대로 유지됩니다.',
    );
    if (!ok) return;
    setRevoking(true);
    setError(null);
    setRevoked(false);
    try {
      const res = await fetch('/api/account/sessions', { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? '처리하지 못했습니다');
        return;
      }
      setRevoked(true);
    } catch {
      setError('네트워크 오류');
    } finally {
      setRevoking(false);
    }
  };

  /**
   * 탈퇴. 본인 확인은 저장과 같은 값(입장 때 확인한 비밀번호)으로 합니다.
   * 무엇이 지워지는지는 버튼 옆 문구와 /privacy 2항에 — 확인 대화상자 한 번 더.
   */
  const leave = async () => {
    if (phase.kind !== 'edit') return;
    const ok = window.confirm(
      '정말 탈퇴할까요?\n글·댓글·리뷰·평가·즐겨찾기는 바로 지워지고, 오락실 제보는 익명으로 남습니다. 되돌릴 수 없습니다.',
    );
    if (!ok) return;
    setLeaving(true);
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: phase.currentPassword ?? undefined }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? '탈퇴하지 못했습니다');
        return;
      }
      setSession(null);
      router.replace('/');
    } catch {
      setError('네트워크 오류');
    } finally {
      setLeaving(false);
    }
  };

  if (phase.kind === 'loading') {
    return (
      <main className="login-page">
        <p className="muted pad">불러오는 중…</p>
      </main>
    );
  }

  if (phase.kind === 'anonymous') {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>로그인이 필요합니다</h1>
          <p className="muted small">개인정보를 수정하려면 먼저 로그인해 주세요.</p>
          <div className="form-actions">
            <Link className="btn btn-primary btn-sm" href={`/login?next=${encodeURIComponent('/account')}`}>
              로그인 화면
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (phase.kind === 'gate') {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={verify}>
          <h1>본인 확인</h1>
          <p className="muted small">
            닉네임과 비밀번호를 바꾸는 화면입니다. 계속하려면 비밀번호를 입력해 주세요.
          </p>

          <label className="field">
            <span>비밀번호</span>
            <input
              autoFocus
              type="password"
              value={gatePassword}
              autoComplete="current-password"
              onChange={(e) => setGatePassword(e.target.value)}
            />
          </label>

          {error && <p className="warn">{error}</p>}

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !gatePassword}>
              {busy ? '확인 중…' : '확인'}
            </button>
            <Link className="btn" href={next}>
              돌아가기
            </Link>
          </div>

          {isAdmin && <AdminTools />}
        </form>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>개인정보 수정</h1>
        <p className="muted small">
          {phase.hasPassword
            ? '닉네임을 바꾸거나 새 비밀번호를 정할 수 있습니다. 비밀번호 칸을 비워 두면 지금 것이 유지됩니다.'
            : '이 계정에는 아직 비밀번호가 없습니다. 닉네임을 확인하고 비밀번호를 설정해 주세요 — 다음부터 이 화면은 비밀번호로 본인을 확인합니다.'}
        </p>

        <label className="field">
          <span>닉네임 (2~20자, 공백 없이)</span>
          <input
            type="text"
            value={nickname}
            maxLength={20}
            autoComplete="off"
            onChange={(e) => setNickname(e.target.value)}
          />
        </label>

        <label className="field">
          <span>{phase.hasPassword ? `새 비밀번호 (선택, ${MIN_PASSWORD_LENGTH}자 이상)` : `비밀번호 (${MIN_PASSWORD_LENGTH}자 이상)`}</span>
          <input
            type="password"
            value={newPassword}
            autoComplete="new-password"
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>

        <label className="field">
          <span>비밀번호 확인</span>
          <input
            type="password"
            value={newPasswordConfirm}
            autoComplete="new-password"
            onChange={(e) => setNewPasswordConfirm(e.target.value)}
          />
        </label>

        {error && <p className="warn">{error}</p>}
        {saved && !error && <p className="muted small">저장했습니다.</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !nickname.trim()}>
            {busy ? '저장 중…' : '저장'}
          </button>
          <button type="button" className="btn" onClick={() => router.push(next)}>
            돌아가기
          </button>
        </div>

        <section className="account-section">
          <h2>로그인 중인 기기</h2>
          <p className="muted small">
            PC방이나 남의 기기에 로그인한 채로 두고 왔다면 여기서 끊을 수 있습니다. 지금 이
            창은 그대로 유지되고, 나머지는 다음 요청부터 다시 로그인해야 합니다.
            비밀번호를 바꾸면 같은 일이 자동으로 일어납니다.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void revokeOthers()}
              disabled={busy || leaving || revoking}
            >
              {revoking ? '처리 중…' : '다른 기기에서 모두 로그아웃'}
            </button>
            {revoked && <span className="muted small">끊었습니다.</span>}
          </div>
        </section>

        {isAdmin && <AdminTools />}

        <section className="danger-zone">
          <h2>탈퇴</h2>
          <p className="muted small">
            계정과 글·댓글·리뷰·평가·즐겨찾기가 바로 지워집니다. 오락실 제보는 작성자 정보만 지워져
            익명으로 남습니다 (<Link href="/privacy">개인정보처리방침</Link> 2항).
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void leave()}
              disabled={busy || leaving}
            >
              {leaving ? '처리 중…' : '탈퇴하기'}
            </button>
          </div>
        </section>
      </form>
    </main>
  );
}
