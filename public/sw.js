/* eslint-disable no-restricted-globals */
/**
 * 서비스 워커 — 설치형 웹앱(PWA)의 최소 조건 + 오프라인 안내.
 *
 * 무엇을 캐시하고 무엇을 안 하는가 (이 순서가 곧 설계입니다):
 *   1. `/_next/static/**`  — 해시가 붙은 불변 파일. cache-first. 배포마다 이름이 바뀌어 낡을 수 없다.
 *   2. `/icons/**`, `/icon.svg`, `/apple-icon.png` — 아이콘. cache-first.
 *   3. 화면 이동(navigate) — **network-first, 캐시하지 않음.** 실패하면 미리 담아 둔 /offline.
 *      HTML 을 캐시하면 배포 뒤에도 옛 화면이 뜨고, 로그인 상태가 섞인 화면이 남는다.
 *   4. `/api/**` — **절대 캐시하지 않는다.** 대기 인원·제보는 4시간 뒤 사라지는 값이고,
 *      즐겨찾기·내 클리어는 로그인한 사람마다 다르다. 낡은 값을 보여 주는 지도는 없는 것보다 나쁘다.
 *   5. 그 밖의 GET(폰트·지도 타일 등 외부) — 건드리지 않는다 (네이버 지도 SDK 는 스스로 캐시한다).
 *
 * 버전: CACHE 이름을 바꾸면 activate 에서 옛 캐시를 지운다. 정적 파일은 해시라 실제로
 * 바꿀 일은 /offline 의 모양이 바뀔 때뿐이다.
 */
const CACHE = 'arcade-finder-v1';
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // 새 워커는 기다리지 않고 바로 — HTML 을 캐시하지 않으므로 갈아타도 화면이 어긋나지 않는다
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isImmutableAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/icon.svg' ||
    url.pathname === '/apple-icon.png'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 4번 — 손대지 않는다

  // 3번 — 화면 이동
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(OFFLINE_URL);
        return cached ?? new Response('오프라인입니다', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }),
    );
    return;
  }

  // 1·2번 — 불변 파일
  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
  }
});
