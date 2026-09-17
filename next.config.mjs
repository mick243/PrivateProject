/**
 * 모든 응답에 붙는 보안 헤더.
 *
 * 2026-09-13 QA 까지 이 앱은 보안 헤더가 **하나도** 없었습니다. XSS 는 구조적으로
 * 닫혀 있지만(본문이 JSON 트리 + 화이트리스트), 헤더가 없으면 관리자가 로그인한
 * 채로 우리 화면이 남의 iframe 에 얹히는 것을 막을 수 없습니다(클릭재킹).
 *
 * CSP 를 'script-src self' 로 좁히지 못하는 이유: Next 가 하이드레이션 데이터를
 * 인라인 <script> 로 넣고, 네이버 지도 SDK 가 자기 스크립트를 더 붙입니다. nonce 를
 * 쓰려면 모든 페이지가 동적 렌더가 되어야 해서(정적 10개가 사라집니다) 지금 규모에
 * 맞지 않습니다. 대신 **프레임·폼·베이스·객체** 를 닫아 실제 피해 경로를 막고,
 * 스크립트 출처는 허용 목록으로 좁힙니다.
 */
const isDev = process.env.NODE_ENV !== 'production';

/**
 * 개발에서만 푸는 두 가지.
 *
 *   'unsafe-eval'  React 개발 빌드가 콜스택 복원 등에 eval 을 씁니다 (운영 빌드는 안 씁니다)
 *   ws:            HMR 소켓. connect-src 'self' 는 브라우저에 따라 ws: 를 덮지 않습니다
 *
 * 처음에 이 둘을 빼고 넣었더니 `npm run dev` 가 통째로 깨졌습니다 — 화면은 뜨는데
 * 새로고침 없이 반영이 안 되고 콘솔이 CSP 위반으로 찼습니다. **운영에 나가는 값은
 * 아래 목록 그대로이고, 개발에서만 이 둘이 더 붙습니다.**
 */
const securityHeaders = [
  // 클릭재킹 — frame-ancestors 가 X-Frame-Options 의 현대판이고 둘 다 둡니다
  { key: 'X-Frame-Options', value: 'DENY' },
  // MIME 스니핑 (업로드가 이 라우트로 나갑니다)
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // 남의 사이트로 나갈 때 전체 주소를 흘리지 않습니다 (?arcade= 같은 것)
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // 쓰지 않는 기기 권한은 끕니다. 위치는 우리 화면에서 쓰므로 self.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      /*
        ⚠ 지도 출처에는 **스킴을 적지 않습니다.**

        네이버 지도 SDK 는 내부 주소를 프로토콜 없이(`//nrbe.map.naver.net/…`) 만들어
        페이지와 같은 스킴으로 붙습니다. 개발은 http://localhost 라 http 로 나가는데,
        `https://` 를 박아 두면 그 요청이 전부 막힙니다 — 실제로 타일·스타일 70여 건이
        막혀 `window.naver.maps` 가 만들어지지 않았습니다(지도가 빈 화면).
        스킴 없는 출처는 페이지와 같은 스킴에 맞고, http 페이지에서는 https 도 함께
        허용됩니다. 운영(https)에서는 https 만 맞으므로 느슨해지지 않습니다.

        도메인도 둘입니다 — 최초 SDK 는 `.naver.com`, 타일·스타일·아이콘은
        `.naver.net` 입니다. 처음 목록에 `.naver.net` 이 통째로 빠져 있었습니다.
      */
      // Next 의 인라인 부트스트랩 + 네이버 지도 SDK(+ 스타일 JSONP)
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} oapi.map.naver.com openapi.map.naver.com *.pstatic.net *.map.naver.net`,
      "style-src 'self' 'unsafe-inline'",
      // 지도 타일·업로드 이미지·data URI(아이콘). static.naver.net 이 지도 스프라이트를 줍니다.
      "img-src 'self' data: blob: *.pstatic.net *.map.naver.com *.naver.net",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      // 우리 API + 지도 SDK 가 부르는 곳
      `connect-src 'self'${isDev ? ' ws: http://localhost:*' : ''} *.map.naver.com *.map.naver.net *.pstatic.net`,
      // 본문에 넣을 수 있는 영상은 youtube-nocookie 뿐입니다 (lib/rich-text.ts)
      'frame-src https://www.youtube-nocookie.com',
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 서버가 무엇인지 광고하지 않습니다
  poweredByHeader: false,

  async headers() {
    return [
      {
        // HSTS 는 여기 두지 않습니다 — TLS 종단(nginx·caddy)이 붙이는 것이 맞고,
        // 앱이 http 로도 뜨는 개발에서 브라우저에 https 를 강제하면 되돌리기 어렵습니다.
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },

  // PGlite ships WASM + native-ish assets; keep it out of the bundler.
  // @opentelemetry/*: instrumentation.ts 가 쓰는 Node 전용 SDK. 번들에 말리면 require 컨텍스트가 깨진다.
  serverExternalPackages: ['@electric-sql/pglite', 'pg', '@opentelemetry/api', '@opentelemetry/sdk-trace-node', '@opentelemetry/sdk-trace-base'],

  // 개발 모드 전용 Next.js 표시(next-logo 버튼)는 Shadow DOM 안에 있어서
  // globals.css 의 display:none 이 먹지 않는다 — 아예 꺼야 한다.
  // (예전엔 기본 위치(좌하단)가 사이드바 등록/취소 버튼을 덮어서 위치만
  // 옮겼었는데, 이제 통째로 숨긴다.)
  devIndicators: false,

  /*
    개발 서버를 터널(cloudflared quick tunnel)로 밖에 내보일 때.

    Next 는 개발에서 서버를 띄운 호스트(localhost)가 아닌 출처에서 오는 `/_next/*`
    요청을 403 으로 막습니다. 터널 주소로 열면 HTML 은 오는데 청크 일부와 HMR
    소켓이 403 이라 하이드레이션이 깨지고, 상단 탭이 눌러도 안 넘어가는 것처럼
    보입니다(2026-09-16). 운영 빌드에는 영향이 없는 개발 전용 설정입니다.
    quick tunnel 은 열 때마다 주소가 바뀌므로 와일드카드로 둡니다.
  */
  allowedDevOrigins: ['*.trycloudflare.com'],

  images: {
    /*
      목록 썸네일만 next/image 를 거칩니다 (components/PostList.tsx 의 PostThumb).
      첨부는 원본 그대로 저장되므로 — 폰 사진 한 장이 3~5MB 입니다 — 줄이지 않고
      목록에 걸면 72px 네모 스무 개를 그리려고 수십 MB 를 받습니다.

      ⚠ localPatterns 를 두면 **여기 없는 경로는 최적화가 400 으로 막힙니다.**
        기본값(설정 없음)은 모든 로컬 경로를 허용하는데, 그러면 최적화 API 가 이
        서버의 아무 경로나 가져다 주는 통로가 됩니다. 지금 next/image 를 쓰는 곳은
        목록 썸네일 하나뿐이라 좁게 잠급니다 — 다른 곳에 next/image 를 붙이면
        그 경로를 여기 함께 적어야 합니다.

      search: '' 는 쿼리 문자열을 아예 받지 않겠다는 뜻입니다 (문서 권고).
      첨부 주소에는 쿼리가 없습니다 (lib/board-types.ts attachmentUrl).
    */
    localPatterns: [{ pathname: '/api/uploads/**', search: '' }],
  },

  // 빌드 산출물 위치. A/B 측정에서만 씁니다 — 같은 코드베이스의 BEFORE/AFTER 를
  // **동시에** 띄워야 배경 프로세스 드리프트가 양쪽에 똑같이 걸려 상쇄되는데
  // (PERFORMANCE.md '2부의 측정 방법'), 산출물이 한 곳이면 둘을 같이 둘 수 없습니다.
  // 빌드와 start 양쪽에 같은 값을 줘야 합니다 (load-test/bench-server.mjs).
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
