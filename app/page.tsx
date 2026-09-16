import Link from 'next/link';
import NewsHero from '@/components/NewsHero';
import { listNews } from '@/lib/board';
import type { PostSummary } from '@/lib/board-types';

/**
 * 홈 — 소식 배너 + 각 화면으로 들어가는 카드.
 *
 * 예전에는 이 자리가 오락실 파인더였습니다(지금은 /finder). 지도를 문 앞에 두면
 * "여기가 지도 서비스" 로 읽혀서, 서열표·커뮤니티가 탭 뒤에 숨는 문제가 있었습니다.
 *
 * ⚠ **따로 만든 소식 표는 없습니다.** 배너는 커뮤니티 글 중 공지·대회·정보 말머리만
 *   골라 옵니다 (lib/board.ts NEWS_CATEGORIES). 자유·질문·공략은 잡담이라 뺍니다.
 *
 * 서버 컴포넌트라 DB 를 바로 읽습니다 — /api/posts 를 한 번 더 타면 왕복만 늘어납니다.
 */

/**
 * 바로 가기 카드 — 위는 비주얼, 아래는 어두운 띠에 이름과 한 줄 설명.
 *
 * 목적지에는 사진이 없습니다(오락실 목록·제보·서열표·게시판은 그림이 아니라 화면입니다).
 * 그래서 소식 배너와 **같은 계열의 어두운 한랭색**을 깔고 얇은 선 아이콘을 얹습니다 —
 * 두 구역이 한 벌로 읽히고, 나중에 대표 이미지가 생기면 gradient 자리만 바꾸면 됩니다.
 */
const NAV_CARDS = [
  {
    href: '/finder',
    label: '오락실 파인더',
    desc: '내 주변 오락실을 기종으로 찾기',
    tint: 'linear-gradient(150deg, #111a2e 0%, #1d3357 60%, #2b4a74 100%)',
    // 지도 핀
    icon: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z M12 10.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z',
  },
  {
    href: '/live',
    label: '실시간 제보',
    desc: '기종이 들어오고 빠진 소식',
    tint: 'linear-gradient(150deg, #101c26 0%, #1b3a4a 60%, #28566a 100%)',
    // 전파
    icon: 'M12 13a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z M8.2 15.2a5.4 5.4 0 0 1 0-7.6 M15.8 7.6a5.4 5.4 0 0 1 0 7.6 M5.4 18a9.4 9.4 0 0 1 0-13.2 M18.6 4.8a9.4 9.4 0 0 1 0 13.2',
  },
  {
    href: '/tier',
    label: '서열표 · 채보 평가',
    desc: '같은 레벨 안의 체감 난이도',
    tint: 'linear-gradient(150deg, #161428 0%, #292350 60%, #3b356e 100%)',
    // 막대 셋
    icon: 'M6 19V11 M12 19V5 M18 19v-5 M3.5 19h17',
  },
  {
    href: '/community',
    label: '커뮤니티',
    desc: '게임별 공략 · 질문 · 대회',
    tint: 'linear-gradient(150deg, #141a1c 0%, #24383c 60%, #345054 100%)',
    // 말풍선
    icon: 'M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L5 20l1.1-3.1A6.3 6.3 0 0 1 4 12.5C4 8.9 7.6 6 12 6s8 2.9 8 6.5Z',
  },
] as const;

/**
 * ⚠ 이 줄이 없으면 홈이 **정적으로 구워집니다.**
 *
 * listNews 는 DB 를 읽지만 cookies·headers 같은 동적 API 를 쓰지 않아서, Next 가
 * 빌드 시점에 한 번 실행하고 그 결과를 HTML 에 박아 둡니다. 실제로 그렇게 나왔고
 * (`○ /`), 그러면 "최신 소식" 이 배포한 날짜에서 멈춥니다.
 *
 * force-dynamic 대신 60초 재생성을 쓰는 이유: 소식은 초 단위로 바뀌지 않고, 홈은
 * 모든 방문이 지나는 자리라 매 요청마다 DB 를 치면 가장 비싼 화면이 됩니다.
 * 빌드 때 DB 에 못 닿아 빈 소식이 구워져도 60초 뒤 스스로 회복합니다.
 */
export const revalidate = 60;

export default async function Page() {
  // 소식이 비어도 홈은 떠야 합니다 — DB 가 흔들릴 때 카드까지 같이 사라지면
  // 갈 곳이 없어집니다 (폴백 중이면 lib/db.ts 가 로컬 사본으로 답합니다).
  let news: PostSummary[] = [];
  let newsFailed = false;
  try {
    news = await listNews(6);
  } catch {
    newsFailed = true;
  }

  return (
    <div className="home">
      {news.length > 0 ? (
        <NewsHero posts={news} />
      ) : (
        <section className="home-news-empty">
          <h1>최신 소식</h1>
          {newsFailed ? (
            <p className="muted small">소식을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.</p>
          ) : (
            <p className="muted small">
              아직 올라온 소식이 없습니다. <Link href="/community">커뮤니티</Link>에 공지 · 대회 ·
              정보 말머리로 글을 남기면 여기에 올라옵니다.
            </p>
          )}
        </section>
      )}

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
              <span className="home-card-visual" style={{ background: c.tint }} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="36" height="36">
                  <path
                    d={c.icon}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="home-card-cap">
                <span className="home-card-label">{c.label}</span>
                <span className="home-card-desc">{c.desc}</span>
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
