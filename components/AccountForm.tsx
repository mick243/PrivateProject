'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MIN_PASSWORD_LENGTH, safeNext, type SessionUser } from '@/lib/auth-types';
import { setBlocked, useBlockedPlayers } from '@/lib/use-blocks';
import { setSession, useIsAdmin } from '@/lib/use-session';

/**
 * 내 정보 화면 (`/account`).
 *
 * 닉네임은 제보·리뷰·글·댓글에 찍히는 이름이라, 세션 쿠키만 믿고 바꿔 주지
 * 않습니다 — **비밀번호를 다시 물어** 본인임을 확인하고 들어옵니다
 * (app/api/account/verify). 소셜로만 가입해 비밀번호가 없는 계정은 대조할 것이
 * 없으므로 검증 없이 들어옵니다.
 *
 * ─── 목록에서 하나를 골라 들어가는 모양 (2026-09-29) ───────────────
 * 예전에는 한 카드에 닉네임 · 새 비밀번호 · 비밀번호 확인 칸과 저장 · 돌아가기 버튼,
 * 그 아래 "다른 기기 로그아웃" · 관리자 도구 · 탈퇴 구역이 한꺼번에 있었습니다.
 * 한 화면에 할 일이 다섯이었고, 탈퇴 단추가 저장 단추와 같은 스크롤 안에 있었습니다.
 * 지금은 **메뉴 → 한 가지 일** 로 나눕니다 (docs/DESIGN-GUIDE.md §1-2). 각 화면에는
 * 질문 하나와 주 버튼 하나만 있고, 끝나면 메뉴로 돌아와 무엇이 됐는지 한 줄로 알립니다.
 *
 * 다른 기기 로그아웃 · 탈퇴는 **그 화면 자체가 확인 단계**입니다. 예전에는 버튼을 누른
 * 뒤 브라우저 확인 창을 한 번 더 띄웠는데, 이제는 메뉴에서 고르는 것이 첫 번째,
 * 결과를 읽고 누르는 것이 두 번째 확인이라 창을 겹쳐 띄우지 않습니다.
 *
 * 비밀번호가 없는 계정에게 예전에는 "저장하려면 비밀번호를 반드시 정하라" 고 했습니다.
 * 서버는 그렇게 요구하지 않고(app/api/account PUT), 세션만 있으면 비밀번호를 정할 수
 * 있어 막는 효과도 없었습니다. 그래서 막지 않고 메뉴 맨 위에서 권합니다.
 *
 * ⚠ 여기서 하는 검사는 거들 뿐 — 판정은 서버(lib/validation.ts
 *   accountUpdateSchema · app/api/account)가 합니다.
 */

/** /welcome 과 같은 닉네임 규칙(문구도 lib/validation.ts 와 같게). 통과해도 서버가 다시 봅니다 */
function nicknameIssue(nickname: string): string | null {
  const name = nickname.trim();
  if (name.length < 2) return '닉네임은 2자 이상으로 써 주세요';
  if (name.length > 20) return '닉네임은 20자까지 쓸 수 있어요';
  if (/\s/.test(name)) return '닉네임은 띄어쓰기 없이 써 주세요';
  return null;
}

function passwordIssue(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`;
  }
  if (password !== confirm) return '두 비밀번호가 달라요. 다시 확인해 주세요';
  return null;
}

const NETWORK_ERROR = '연결이 잠깐 끊겼어요. 다시 시도해 주세요';

type Phase =
  /** 계정 상태(비밀번호 유무)를 서버에 묻는 중 */
  | { kind: 'loading' }
  /** 로그인이 없다 */
  | { kind: 'anonymous' }
  /** 비밀번호가 있는 계정 — 입장 전 확인 */
  | { kind: 'gate' }
  /** 들어왔다. currentPassword 는 저장 요청의 본인 확인에 다시 들어갑니다 */
  | { kind: 'open'; currentPassword: string | null; hasPassword: boolean };

/** 들어온 뒤 보이는 화면 — 메뉴, 또는 한 가지 일 */
type View = 'menu' | 'nickname' | 'password' | 'devices' | 'blocked' | 'leave';

/**
 * 내가 차단한 사람 (lib/use-blocks.ts). 차단은 글 · 댓글 옆의 '⋯' 단추로 하고, 여기서 풉니다.
 * 메뉴의 '차단한 사용자' 로 들어오는 한 가지 일 화면의 본문입니다 — 본인 확인(gate) 뒤에만
 * 보입니다. 누구를 차단했는지도 남이 볼 일은 아닙니다.
 */
function BlockedList() {
  const blocked = useBlockedPlayers();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unblock = async (p: { playerId: number; nickname: string }) => {
    setBusyId(p.playerId);
    setError(await setBlocked(p, false));
    setBusyId(null);
  };
  return (
    <>
      {blocked.length === 0 ? (
        <p className="muted small">
          아직 차단한 사람이 없어요. 글 · 댓글 · 리뷰 옆의 ⋯ 단추로 차단하면 그 사람의 글이 내
          화면에서 가려져요.
        </p>
      ) : (
        <ul className="mod-list">
          {blocked.map((p) => (
            <li key={p.playerId} className="mod-card-head">
              <strong>{p.nickname}</strong>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyId === p.playerId}
                onClick={() => void unblock(p)}
              >
                {busyId === p.playerId ? '푸는 중…' : '차단 풀기'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="warn small" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export default function AccountForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const isAdmin = useIsAdmin();

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [view, setView] = useState<View>('menu');
  /** 지금 계정의 닉네임 (메뉴에 보이는 값) */
  const [nickname, setNickname] = useState('');
  /** 닉네임 바꾸기 화면에서 고치는 값 */
  const [draftNickname, setDraftNickname] = useState('');
  const [gatePassword, setGatePassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 메뉴로 돌아왔을 때 한 줄로 알리는 결과 */
  const [notice, setNotice] = useState<string | null>(null);

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
        // 비밀번호가 없으면 대조할 것이 없으므로 곧장 메뉴로.
        setPhase(
          data.hasPassword
            ? { kind: 'gate' }
            : { kind: 'open', currentPassword: null, hasPassword: false },
        );
      } catch {
        if (alive) setPhase({ kind: 'anonymous' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 한 가지 일로 들어간다 — 입력값과 알림을 비우고 */
  const openView = (target: View) => {
    setError(null);
    setNotice(null);
    setDraftNickname(nickname);
    setNewPassword('');
    setNewPasswordConfirm('');
    setView(target);
  };

  /** 메뉴로 돌아온다 — 방금 한 일을 한 줄로 알리며 */
  const backToMenu = (message: string | null = null) => {
    setError(null);
    setNotice(message);
    setView('menu');
  };

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
        setError(data.error ?? '비밀번호를 확인하지 못했어요. 다시 시도해 주세요');
        return;
      }
      setPhase({ kind: 'open', currentPassword: gatePassword, hasPassword: true });
      setView('menu');
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  /** PUT /api/account — 닉네임 또는 비밀번호 한 가지만 보냅니다 */
  const save = async (change: { nickname: string } | { newPassword: string }) => {
    if (phase.kind !== 'open') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: phase.currentPassword ?? undefined,
          ...('nickname' in change
            ? { nickname: change.nickname }
            : { newPassword: change.newPassword, newPasswordConfirm: change.newPassword }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '저장하지 못했어요. 다시 시도해 주세요');
        return;
      }

      // 세션 쿠키가 다시 서명돼 왔습니다 — 상단 네비가 곧바로 따라오도록
      // 스토어에도 심어 줍니다 (/welcome 과 같은 처리).
      const saved = data.user as SessionUser;
      setSession(saved);
      setNickname(saved.nickname);
      if ('nickname' in change) {
        backToMenu('닉네임을 바꿨어요');
      } else {
        // 방금 정한 비밀번호가 다음 저장의 본인 확인 값이 됩니다.
        setPhase({ kind: 'open', currentPassword: change.newPassword, hasPassword: true });
        backToMenu(
          phase.hasPassword
            ? '비밀번호를 바꿨어요. 다른 기기의 로그인은 모두 끊겼어요'
            : '비밀번호를 정했어요. 이제 아이디로도 로그인할 수 있어요',
        );
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const submitNickname = (e: React.FormEvent) => {
    e.preventDefault();
    const issue = nicknameIssue(draftNickname);
    if (issue) {
      setError(issue);
      return;
    }
    if (draftNickname.trim() === nickname) {
      backToMenu();
      return;
    }
    void save({ nickname: draftNickname.trim() });
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    const issue = passwordIssue(newPassword, newPasswordConfirm);
    if (issue) {
      setError(issue);
      return;
    }
    void save({ newPassword });
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
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/sessions', { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? '로그아웃하지 못했어요. 다시 시도해 주세요');
        return;
      }
      backToMenu('다른 기기의 로그인을 모두 끊었어요');
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 탈퇴. 본인 확인은 저장과 같은 값(입장 때 확인한 비밀번호)으로 합니다.
   * 무엇이 지워지는지는 이 화면의 문구와 /privacy 2항에 있습니다.
   */
  const leave = async () => {
    if (phase.kind !== 'open') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: phase.currentPassword ?? undefined }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? '탈퇴하지 못했어요. 다시 시도해 주세요');
        return;
      }
      setSession(null);
      router.replace('/');
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = error && (
    <p className="warn" role="alert">
      {error}
    </p>
  );

  const backLink = (
    <div className="link-row">
      <button type="button" className="btn-link" disabled={busy} onClick={() => backToMenu()}>
        이전으로
      </button>
    </div>
  );

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
          <h1>먼저 로그인해 주세요</h1>
          <p className="muted small">로그인하면 닉네임과 비밀번호를 바꿀 수 있어요.</p>
          <Link
            className="btn btn-primary btn-block"
            href={`/login?next=${encodeURIComponent('/account')}`}
          >
            로그인하러 가기
          </Link>
        </section>
      </main>
    );
  }

  if (phase.kind === 'gate') {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={verify}>
          <h1>비밀번호를 한 번 더 확인할게요</h1>
          <p className="muted small">내 정보를 지키려고 들어올 때마다 물어요.</p>

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

          {errorLine}

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={busy || !gatePassword}
          >
            {busy ? '확인하는 중…' : '내 정보 열기'}
          </button>
          <div className="link-row">
            <Link className="btn-link" href={next}>
              보던 화면으로 돌아가기
            </Link>
            {/* 관리 페이지는 링크 하나라 비밀번호를 다시 물을 이유가 없고, 그 페이지가 서버에서
                다시 판정합니다 (app/api/emoticons/admin requireAdmin). */}
            {isAdmin && (
              <Link className="btn-link" href="/admin">
                관리 화면
              </Link>
            )}
            {isAdmin && (
              <Link className="btn-link" href="/admin/emoticons">
                이모티콘 관리
              </Link>
            )}
          </div>
        </form>
      </main>
    );
  }

  if (view === 'nickname') {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={submitNickname}>
          <h1>새 닉네임을 정해 주세요</h1>
          <label className="field">
            <span>닉네임</span>
            <input
              autoFocus
              type="text"
              value={draftNickname}
              maxLength={20}
              autoComplete="off"
              aria-describedby="account-hint"
              onChange={(e) => setDraftNickname(e.target.value)}
            />
          </label>
          <p id="account-hint" className="muted small">
            지금까지 쓴 글과 리뷰의 이름도 함께 바뀌어요. 2~20자, 띄어쓰기 없이 써 주세요.
          </p>
          {errorLine}
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={busy || !draftNickname.trim()}
          >
            {busy ? '바꾸는 중…' : '이 닉네임으로 바꾸기'}
          </button>
          {backLink}
        </form>
      </main>
    );
  }

  if (view === 'password') {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={submitPassword}>
          <h1>{phase.hasPassword ? '새 비밀번호를 정해 주세요' : '비밀번호를 정해 주세요'}</h1>
          <input type="text" autoComplete="username" value={nickname} readOnly hidden />
          <label className="field">
            <span>{phase.hasPassword ? '새 비밀번호' : '비밀번호'}</span>
            <input
              autoFocus
              type="password"
              value={newPassword}
              maxLength={200}
              autoComplete="new-password"
              aria-describedby="account-hint"
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label className="field">
            <span>한 번 더</span>
            <input
              type="password"
              value={newPasswordConfirm}
              maxLength={200}
              autoComplete="new-password"
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
            />
          </label>
          <p id="account-hint" className="muted small">
            {phase.hasPassword
              ? `${MIN_PASSWORD_LENGTH}자 이상이면 돼요. 바꾸면 다른 기기의 로그인은 모두 끊겨요.`
              : `${MIN_PASSWORD_LENGTH}자 이상이면 돼요. 정해 두면 아이디로도 로그인할 수 있어요.`}
          </p>
          {errorLine}
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={busy || !newPassword || !newPasswordConfirm}
          >
            {busy ? '저장하는 중…' : phase.hasPassword ? '비밀번호 바꾸기' : '비밀번호 정하기'}
          </button>
          {backLink}
        </form>
      </main>
    );
  }

  if (view === 'devices') {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>다른 기기에서 로그아웃할까요?</h1>
          <p className="muted small">
            PC방이나 남의 기기에 로그인한 채 두고 왔다면 여기서 끊을 수 있어요. 지금 이 창은
            그대로예요.
          </p>
          {errorLine}
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() => void revokeOthers()}
          >
            {busy ? '로그아웃하는 중…' : '다른 기기에서 모두 로그아웃하기'}
          </button>
          {backLink}
        </section>
      </main>
    );
  }

  if (view === 'blocked') {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>차단한 사용자</h1>
          <BlockedList />
          {backLink}
        </section>
      </main>
    );
  }

  if (view === 'leave') {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>정말 탈퇴할까요?</h1>
          <p className="muted small">
            글 · 댓글 · 리뷰 · 평가 · 즐겨찾기가 바로 지워지고 되돌릴 수 없어요. 오락실 제보는
            이름만 지우고 익명으로 남겨요 (<Link href="/privacy">개인정보처리방침</Link> 2항).
          </p>
          {errorLine}
          <button
            type="button"
            className="btn btn-danger btn-block"
            disabled={busy}
            onClick={() => void leave()}
          >
            {busy ? '탈퇴하는 중…' : '탈퇴하기'}
          </button>
          {backLink}
        </section>
      </main>
    );
  }

  // 메뉴 — 한 가지 일을 고르는 화면
  return (
    <main className="login-page">
      <section className="login-card">
        <h1>내 정보</h1>
        <p className="login-who">{nickname}</p>

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {!phase.hasPassword && !notice && (
          <p className="muted small">
            아직 비밀번호가 없어요. 정해 두면 아이디로도 로그인할 수 있고, 이 화면을 비밀번호로
            지킬 수 있어요.
          </p>
        )}

        <nav className="account-menu" aria-label="내 정보 메뉴">
          {!phase.hasPassword && (
            <MenuRow label="비밀번호 정하기" onClick={() => openView('password')} />
          )}
          <MenuRow label="닉네임 바꾸기" sub={nickname} onClick={() => openView('nickname')} />
          {phase.hasPassword && (
            <MenuRow label="비밀번호 바꾸기" onClick={() => openView('password')} />
          )}
          <MenuRow
            label="다른 기기에서 로그아웃"
            sub="두고 온 로그인을 끊어요"
            onClick={() => openView('devices')}
          />
          <MenuRow
            label="차단한 사용자"
            sub="가린 사람을 보고 차단을 풀어요"
            onClick={() => openView('blocked')}
          />
          {/* 관리 페이지는 서버에서 다시 판정합니다 (requireAdmin) — 여기는 링크뿐 */}
          {isAdmin && (
            <Link className="account-menu-row" href="/admin">
              <span>
                <strong>관리 화면</strong>
                <span className="muted small">신고함 · 계정 정지 · AI가 찾은 게임 승인</span>
              </span>
              <span className="account-menu-chevron" aria-hidden="true">
                ›
              </span>
            </Link>
          )}
          {isAdmin && (
            <Link className="account-menu-row" href="/admin/emoticons">
              <span>
                <strong>이모티콘 관리</strong>
                <span className="muted small">관리자</span>
              </span>
              <span className="account-menu-chevron" aria-hidden="true">
                ›
              </span>
            </Link>
          )}
        </nav>

        <div className="link-row">
          <Link className="btn-link" href={next}>
            보던 화면으로 돌아가기
          </Link>
        </div>

        {/* 되돌릴 수 없는 일은 맨 아래, 메뉴와 떨어뜨려 둡니다 (docs/DESIGN-GUIDE.md §1-2) */}
        <div className="account-leave">
          <button type="button" className="btn-link is-danger" onClick={() => openView('leave')}>
            탈퇴하기
          </button>
        </div>
      </section>
    </main>
  );
}

/** 메뉴 한 줄 — 누르면 그 일 하나만 하는 화면으로 들어갑니다 */
function MenuRow({ label, sub, onClick }: { label: string; sub?: string; onClick: () => void }) {
  return (
    <button type="button" className="account-menu-row" onClick={onClick}>
      <span>
        <strong>{label}</strong>
        {sub && <span className="muted small">{sub}</span>}
      </span>
      <span className="account-menu-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
