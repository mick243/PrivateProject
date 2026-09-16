import type { Metadata, Viewport } from 'next';
import ChatBotHost from '@/components/ChatBotHost';
import HistoryBar from '@/components/HistoryBar';
import PwaSetup from '@/components/PwaSetup';
import TopNav from '@/components/TopNav';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { publicAppUrl } from '@/lib/app-url';
import './globals.css';

const TITLE = '오락실 파인더';
const DESCRIPTION = '내 주변 오락실 위치 · 보유 기종 · 실시간 대기 제보를 모으는 크라우드소싱 지도와 리듬게임 커뮤니티';

export const metadata: Metadata = {
  // 상대 경로(OG 이미지·canonical)를 절대 주소로 바꾸는 기준. 운영은 APP_URL 필수.
  metadataBase: new URL(publicAppUrl()),
  title: {
    default: TITLE,
    // 각 page.tsx 는 화면 이름만 적으면 됩니다 ('서열표' → '서열표 — 오락실 파인더')
    template: `%s — ${TITLE}`,
  },
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: {
    type: 'website',
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
    locale: 'ko_KR',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
  // 설치형 웹앱(PWA) — 매니페스트는 app/manifest.ts 가 자동으로 <link> 됩니다 (docs/PWA.md).
  // iOS 는 매니페스트를 절반만 읽으므로 홈 화면 이름·전체 화면·상태바를 여기서 따로 말해 줍니다.
  appleWebApp: {
    capable: true,
    title: '오락실',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  // 아이콘은 app/icon.svg(탭) · app/apple-icon.png(iOS 홈) · OG 이미지는 app/opengraph-image.tsx 가 자동으로 붙습니다.
};

export const viewport: Viewport = {
  themeColor: '#161a22',
  width: 'device-width',
  initialScale: 1,
  // 홈 화면 앱(standalone)에서 노치·홈 인디케이터 뒤까지 그리고, safe-area 는 CSS 가 챙깁니다
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
      suppressHydrationWarning — 아래 스크립트가 서버가 보낸 HTML 에 없던
      data-theme 을 <html> 에 붙입니다. React 는 그걸 '서버와 다르다' 고 경고하는데,
      여기서는 의도한 차이입니다 (테마는 브라우저만 아는 값입니다).
    */
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/*
          번들이 아니라 문서 안에서 **동기적으로** 돌아야 합니다 — 첫 페인트보다
          늦으면 고른 테마 대신 기본 테마가 한 번 번쩍입니다 (lib/theme.ts).
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <TopNav />
        {/* 챗봇을 모든 화면에 하나만 띄웁니다 — 파인더가 떠 있는 동안에만 탐색
            기능이 붙습니다 (components/ChatBotHost.tsx). children 을 감싸는 이유는
            파인더(children 안)와 챗봇(아래)이 같은 context 를 봐야 하기 때문입니다. */}
        <ChatBotHost>{children}</ChatBotHost>
        {/* 화면 아래 가운데에 떠 있는 뒤로 · 앞으로 · 새로고침 (components/HistoryBar.tsx).
            모든 화면에 있어야 하므로 페이지가 아니라 레이아웃에 답니다. */}
        <HistoryBar />
        <PwaSetup />
      </body>
    </html>
  );
}
