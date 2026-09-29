import Link from 'next/link';
import NewsHero from '@/components/NewsHero';
import { GAME_SITES } from '@/lib/game-sites';

/**
 * 홈 — 게임 공식 홈페이지 배너 + 각 화면으로 들어가는 카드.
 *
 * 예전에는 이 자리가 오락실 파인더였습니다(지금은 /finder). 지도를 문 앞에 두면
 * "여기가 지도 서비스" 로 읽혀서, 서열표·커뮤니티가 탭 뒤에 숨는 문제가 있었습니다.
 *
 * 배너는 한때 커뮤니티의 공지·대회·정보 글(긁어 온 공식 공지 포함)을 보여 줬습니다.
 * 지금은 **게임 공식 홈페이지 링크만** 겁니다 (lib/game-sites.ts 머리말 — 약관). 그래서
 * 이 화면은 DB 를 읽지 않고, 빌드할 때 한 번 구워지는 정적 화면입니다.
 */

/**
 * 바로 가기 카드 — 아이콘 · 이름 · 한 줄 설명이 든 판판한 회색 판.
 *
 * 목적지에는 사진이 없습니다(오락실 목록·제보·서열표·게시판은 그림이 아니라 화면입니다).
 * 예전에는 그 빈자리를 색이 다른 그라데이션 넷으로 채웠는데, 네 장이 제각각 빛나서
 * "생성된 화면" 처럼 읽혔습니다. 지금은 넷 다 같은 회색 판이고, 다른 것은 아이콘뿐입니다
 * (docs/VISUAL-DESIGN.md).
 */
const NAV_CARDS = [
  {
    href: '/finder',
    label: '오락실 찾기',
    desc: '내 주변 오락실을 기종으로 찾기',
    // 지도 핀
    icon: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z M12 10.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z',
  },
  {
    href: '/live',
    label: '실시간 제보',
    desc: '기종이 들어오고 빠진 소식',
    // 전파
    icon: 'M12 13a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z M8.2 15.2a5.4 5.4 0 0 1 0-7.6 M15.8 7.6a5.4 5.4 0 0 1 0 7.6 M5.4 18a9.4 9.4 0 0 1 0-13.2 M18.6 4.8a9.4 9.4 0 0 1 0 13.2',
  },
  {
    href: '/tier',
    label: '서열표 · 채보 평가',
    desc: '같은 레벨 안의 체감 난이도',
    // 막대 셋
    icon: 'M6 19V11 M12 19V5 M18 19v-5 M3.5 19h17',
  },
  {
    href: '/community',
    label: '커뮤니티',
    desc: '게임별 공략 · 질문 · 대회',
    // 말풍선
    icon: 'M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L5 20l1.1-3.1A6.3 6.3 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5Z',
  },
] as const;

export default function Page() {
  return (
    <div className="home">
      <NewsHero sites={GAME_SITES} />

      <div className="home-body">
        <div className="home-sec-head">
          <h2>바로 가기</h2>
          <Link href="/community" className="home-more">
            소식 전체 보기
          </Link>
        </div>

        <nav className="home-cards" aria-label="바로 가기">
          {NAV_CARDS.map((c) => (
            <Link key={c.href} href={c.href} className="home-card">
              <svg className="home-card-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                <path
                  d={c.icon}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="home-card-label">{c.label}</span>
              <span className="home-card-desc">{c.desc}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
