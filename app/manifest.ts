import type { MetadataRoute } from 'next';

/**
 * /manifest.webmanifest — 설치형 웹앱(PWA) 선언.
 *
 * "앱 버전" 의 1단계입니다. 스토어 없이 오늘 배포되고, Android(Chrome·삼성) 는
 * 홈 화면 추가 프롬프트를, iOS 는 공유 → 홈 화면에 추가를 씁니다. 나중에 스토어에
 * 올릴 때도 이 매니페스트가 그대로 바탕입니다 (TWA/Bubblewrap · Capacitor —
 * docs/PWA.md).
 *
 * 아이콘은 `scripts/make-pwa-icons.mjs` 가 만든 PNG 입니다. SVG(app/icon.svg)는
 * 설치 프롬프트에 안 쓰이고, Chrome 은 192·512 PNG 가 있어야 "설치 가능" 으로 봅니다.
 * `purpose: 'any maskable'` — 여백을 20% 둔 정사각형이라 OS 가 둥글게 잘라도 핀이 남습니다.
 *
 * `display: 'standalone'` — 주소창 없이. 지도 앱이라 화면이 좁으면 안 됩니다.
 * 방향은 고정하지 않습니다 (지도는 가로도 씁니다).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: '오락실 파인더',
    short_name: '오락실',
    description: '내 주변 오락실 지도 · 보유 기종 · 실시간 대기 제보 · 리듬게임 서열표와 커뮤니티',
    lang: 'ko',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    background_color: '#0e1015',
    theme_color: '#161a22',
    categories: ['games', 'navigation', 'social'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: '실시간 제보', short_name: '제보', url: '/live?source=pwa', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: '서열표', short_name: '서열표', url: '/tier?source=pwa', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: '커뮤니티', short_name: '커뮤니티', url: '/community?source=pwa', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
