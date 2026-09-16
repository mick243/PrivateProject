# 앱 버전 — 설치형 웹앱(PWA), 그리고 스토어로 가는 길

> 2026-09-13. "앱으로도 출시" 의 1단계. 스토어 없이 오늘 배포되고, 2단계(스토어 등록)의 바탕이 됩니다.

## 지금 되는 것

| | Android (Chrome · 삼성 인터넷) | iOS (Safari) |
|---|---|---|
| 설치 | 하단 배너 **설치** 버튼 → 홈 화면 아이콘 (`beforeinstallprompt`) | 공유 → **홈 화면에 추가** (배너가 8초 뒤 방법을 알려 줌) |
| 실행 | 주소창 없는 전체 화면 (`display: standalone`) | 같음 (`appleWebApp.capable`) |
| 아이콘 | `public/icons/icon-*.png` (any · maskable) | `app/apple-icon.png` 180px |
| 오프라인 | `/offline` 안내 화면 (서비스 워커가 미리 캐시) | 같음 |
| 바로가기 | 아이콘 길게 누르기 → 실시간 제보 · 서열표 · 커뮤니티 | — |
| 상태바 | `theme_color` #161a22 | `black-translucent` + safe-area 패딩 |

구성 파일: `app/manifest.ts` · `public/sw.js` · `components/PwaSetup.tsx` · `app/offline/page.tsx` ·
`scripts/make-pwa-icons.mjs` · `tests/pwa.test.ts`.

## 서비스 워커가 캐시하는 것 (그리고 안 하는 것)

- **캐시함**: `/_next/static/**`(해시 파일), 아이콘, `/offline`.
- **안 함**: HTML(화면 이동)과 `/api/**` 전부. 대기 인원·제보는 4시간 뒤 사라지는 값이고 즐겨찾기·내 클리어는
  사람마다 다릅니다. 낡은 값을 보여 주는 지도는 없는 것보다 나쁩니다. HTML 을 캐시하면 배포 뒤에도 옛 화면이 남습니다.
- 그래서 **오프라인에서 "되는" 것은 안내 화면뿐**입니다. 지도·제보를 오프라인에서도 보이게 하려면 마지막 응답을
  IndexedDB 에 두고 "N분 전 정보" 라고 표시하는 별도 작업이 필요합니다 — 지금은 하지 않았습니다.

## 확인하는 법

```bash
npm run build && ENV_CHECK=off npm run start      # 서비스 워커는 운영 빌드에서만 등록됩니다
```

Chrome DevTools → **Application** → Manifest(설치 가능 여부·아이콘) · Service Workers(등록·활성) ·
Lighthouse → PWA 카테고리. `/manifest.webmanifest` · `/sw.js` · `/icons/icon-512.png` 가 200 이어야 합니다.
아이콘 그림을 바꿨으면 `npm run pwa:icons` 로 PNG 를 다시 만들고 `app/icon.svg` 도 맞추세요.

운영에서는 **HTTPS 가 필수**입니다 (서비스 워커·설치 프롬프트 모두 localhost 외에는 https 에서만 동작).

## 2단계 — 스토어에 올리기

두 길 다 **지금의 웹을 그대로 감쌉니다.** 별도 앱 코드가 생기지 않습니다.

| | Google Play | App Store |
|---|---|---|
| 방법 | **TWA**(Trusted Web Activity) — [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) 이 이 매니페스트로 Android 프로젝트를 만들어 줍니다 | **Capacitor** 로 iOS 껍데기 (WebView 가 운영 URL 을 열도록 `server.url`) |
| 필요한 것 | JDK 17 + Android SDK, Play 개발자 계정(1회 $25), `/.well-known/assetlinks.json` 에 서명 키 지문 | macOS + Xcode, Apple Developer($99/년) |
| 이 장비 | JDK·SDK 없음 → 설치 뒤 `npx @bubblewrap/cli init --manifest https://<도메인>/manifest.webmanifest` | Windows 라 불가 — Mac 필요 |
| 심사 주의 | 웹뷰 앱은 "웹사이트와 같으면" 거절되지 않음(TWA 는 공식 경로) | Apple 은 "웹사이트를 감싼 앱" 을 4.2 로 거절하기도 함 — 위치·푸시 같은 네이티브 기능이 있어야 유리 |

TWA 의 `assetlinks.json` 은 `public/.well-known/assetlinks.json` 에 두면 됩니다 (Bubblewrap 이 내용을 알려 줍니다).

## 다음으로 붙일 만한 것

- **푸시 알림** (즐겨찾기한 오락실에 대기 제보가 올라오면) — Web Push 는 Android 즉시, iOS 는 16.4+ 홈 화면 설치 상태에서만.
  서버에 구독 저장 + VAPID 키가 필요합니다.
- **마지막 본 지도 오프라인 표시** — 위 "안 함" 항목.
- **스토어 스크린샷** — 매니페스트 `screenshots` 에 넣으면 Chrome 이 더 큰 설치 UI 를 보여 줍니다.
