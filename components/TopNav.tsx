'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import AuthMenu from './AuthMenu';
import PlayerPicker from './PlayerPicker';
import ThemeToggle from './ThemeToggle';

const LINKS = [
  { href: '/finder', label: '오락실 파인더' },
  { href: '/live', label: '실시간 제보' },
  { href: '/tier', label: '서열표 · 채보 평가' },
  { href: '/community', label: '커뮤니티' },
];

export default function TopNav() {
  const pathname = usePathname();
  /** 모바일 폭에서만 쓰는 햄버거 드로어. 데스크톱 폭에서는 CSS 가 항상 열어 둔다. */
  const [open, setOpen] = useState(false);

  // 링크를 눌러 페이지가 바뀌면 드로어를 닫는다.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <nav className="topnav">
      <Link href="/" className="topnav-brand">
        ARCADE
      </Link>

      <button
        type="button"
        className="topnav-burger"
        aria-label={open ? '메뉴 닫기' : '메뉴 열기'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span />
        <span />
        <span />
      </button>

      <div className={open ? 'topnav-links is-open' : 'topnav-links'}>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={pathname === l.href ? 'topnav-link is-on' : 'topnav-link'}
          >
            {l.label}
          </Link>
        ))}
        {/* 왼쪽은 이동, 오른쪽은 "누구로 보고 있는가". 선택(플레이어)과
            로그인(관리자)은 근거가 달라 나란히 두되 붙여 놓습니다. */}
        <div className="topnav-right">
          <ThemeToggle />
          <PlayerPicker />
          <AuthMenu />
        </div>
        {/* 법적 고지는 전역 푸터 대신 여기 — 파인더 화면이 지도로 꽉 차 푸터 자리가 없다.
            데스크톱에서는 오른쪽 끝에 작게, 모바일 드로어에서는 맨 아래 줄로. */}
        <div className="topnav-legal">
          <Link href="/terms">이용약관</Link>
          <Link href="/privacy">개인정보처리방침</Link>
        </div>
      </div>
    </nav>
  );
}
