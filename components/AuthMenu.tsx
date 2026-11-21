'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { refreshSession, setSession, useSession } from '@/lib/use-session';

/**
 * 상단 네비의 로그인 자리.
 *
 * 관리자와 일반 사용자가 같은 버튼으로 들어옵니다 — 아이디/비밀번호와 소셜
 * 로그인 어느 쪽이든 끝나면 같은 세션 쿠키가 되고, 권한 차이는 뱃지로만 드러납니다.
 *
 * 폼 자체는 /login · /signup 페이지에 있습니다. 여기서는 **들어가고 나오는 것**만 맡습니다 —
 * 누구로 들어와 있는지는 옆의 PlayerPicker 가 이름과 권한 뱃지로 보여 줍니다.
 * 예전에는 여기서도 이름을 찍었는데, 나란히 선 두 칸이 같은 이름을 두 번 적고
 * 뱃지는 이름에서 떨어져 로그아웃 버튼에 딸린 것처럼 읽혔습니다.
 *
 * 비로그인에는 로그인과 **가입** 두 길을 둡니다. 예전에는 로그인만 있어 가입하려면
 * 로그인 화면을 한 번 거쳐야 했습니다 (2026-11-20 UX 시험 A-4).
 */

/**
 * 끝나고 돌아올 곳 — **누르는 순간의** 경로 + 쿼리(예: /?arcade=3 · /community?post=9).
 *
 * 렌더할 때 쿼리까지 읽으려면 useSearchParams 가 필요한데, 이 컴포넌트는 레이아웃에 있어서
 * 그러면 모든 페이지가 정적 생성에서 빠집니다. 그래서 링크의 href 는 경로만 담아 두고(새 탭 ·
 * 주소 복사용), 실제로 누를 때 location 에서 쿼리까지 읽어 넘깁니다. 예전에는 경로만 넘겨
 * 오락실 상세를 보다 가입하면 지도 첫 화면으로 돌아갔습니다 (UX 시험 A-1).
 */
function currentPlace(): string {
  const { pathname, search } = window.location;
  // 로그인 ↔ 가입처럼 계정 화면끼리 옮겨 갈 때는 그 화면이 들고 있던 돌아갈 곳을 이어받습니다 —
  // 아니면 가입을 마치고 로그인 화면("이미 로그인했어요")으로 돌아옵니다.
  if (ACCOUNT_PAGES.has(pathname)) return new URLSearchParams(search).get('next') ?? '/';
  return `${pathname}${search}`;
}

const ACCOUNT_PAGES = new Set(['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email']);

export default function AuthMenu() {
  const user = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setSession(null);
      // 쿠키가 정말 지워졌는지는 서버에게 한 번 더 확인한다.
      void refreshSession();
      setBusy(false);
    }
  };

  /** 보조 키(새 탭 등)는 브라우저에 맡기고, 그냥 누르면 쿼리까지 담아 이동합니다 */
  const goWithNext = (target: '/login' | '/signup' | '/account') => (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (pathname === target) return;
    e.preventDefault();
    router.push(`${target}?next=${encodeURIComponent(currentPlace())}`);
  };

  const hrefFor = (target: string) =>
    pathname === target || ACCOUNT_PAGES.has(pathname)
      ? target
      : `${target}?next=${encodeURIComponent(pathname)}`;

  if (user) {
    return (
      <div className="auth-menu">
        {/* 닉네임·비밀번호 수정. 돌아올 곳은 로그인 링크와 같이 누르는 순간의 경로+쿼리. */}
        <Link
          className={pathname === '/account' ? 'btn btn-sm btn-on' : 'btn btn-sm'}
          href={hrefFor('/account')}
          onClick={goWithNext('/account')}
        >
          내 정보
        </Link>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={logout}>
          로그아웃
        </button>
      </div>
    );
  }

  return (
    <div className="auth-menu">
      <Link
        className={pathname === '/login' ? 'btn btn-sm btn-on' : 'btn btn-sm'}
        href={hrefFor('/login')}
        onClick={goWithNext('/login')}
      >
        로그인
      </Link>
      <Link
        className={pathname === '/signup' ? 'btn btn-sm btn-on' : 'btn btn-sm'}
        href={hrefFor('/signup')}
        onClick={goWithNext('/signup')}
      >
        가입하기
      </Link>
    </div>
  );
}
