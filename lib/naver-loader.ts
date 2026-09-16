'use client';

/**
 * 네이버 지도 JS SDK 로더.
 *
 * NCP 콘솔 마이그레이션 이후 인증 파라미터 이름이 ncpClientId → ncpKeyId 로
 * 바뀌었습니다. 발급 시점에 따라 둘 중 하나만 동작하므로 env 로 고를 수 있게 둡니다.
 *   NEXT_PUBLIC_NAVER_MAP_AUTH_PARAM=legacy  → 구버전(ncpClientId)
 */
const KEY_ID = process.env.NEXT_PUBLIC_NAVER_MAP_KEY_ID ?? '';
const IS_LEGACY = process.env.NEXT_PUBLIC_NAVER_MAP_AUTH_PARAM === 'legacy';

export const hasNaverKey = KEY_ID.trim().length > 0;

export function naverScriptUrl(): string {
  return IS_LEGACY
    ? `https://openapi.map.naver.com/openapi/v3/maps.js?ncpClientId=${encodeURIComponent(KEY_ID)}`
    : `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(KEY_ID)}`;
}

let loadPromise: Promise<typeof naver> | null = null;

/**
 * 인증 실패·타임아웃 판정.
 *
 * 2026-09-13 QA 전까지는 `onload`/`onerror` 만 봤습니다. 그런데 **키가 틀리거나 NCP
 * 콘솔에 도메인이 등록되지 않은 경우 SDK 스크립트는 200 으로 로드되고 `naver.maps`
 * 도 존재**합니다 — 실패는 SDK 가 `window.navermap_authFailure` 를 부르는 것으로만
 * 알립니다. 그래서 출시 당일 가장 흔한 사고("운영 도메인 안 넣음")가 회색 빈 지도로
 * 나타났습니다. 이제 그 콜백과 타임아웃을 실패로 잡아 FallbackMap 으로 넘깁니다
 * (components/MapPane.tsx).
 */
const LOAD_TIMEOUT_MS = 10_000;

export class NaverMapsLoadError extends Error {
  constructor(
    message: string,
    /** 사용자에게 보여 줄 문구 — 개발자용 원문(message)과 분리 */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

declare global {
  interface Window {
    navermap_authFailure?: () => void;
  }
}

/** SDK 를 한 번만 주입하고, 로드가 끝나면 naver 네임스페이스를 돌려준다. */
export function loadNaverMaps(): Promise<typeof naver> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('브라우저에서만 로드할 수 있습니다'));
  }
  if (window.naver?.maps) return Promise.resolve(window.naver);
  if (!hasNaverKey) {
    return Promise.reject(new Error('NEXT_PUBLIC_NAVER_MAP_KEY_ID 가 설정되지 않았습니다'));
  }

  loadPromise ??= new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (message: string, userMessage: string) =>
      done(() => {
        // 실패한 약속을 캐시에 남기면 다시 시도할 길이 없다 (키를 고쳐 재배포해도 새 탭에서만)
        loadPromise = null;
        reject(new NaverMapsLoadError(message, userMessage));
      });

    // SDK 가 인증 실패를 알리는 유일한 통로. 스크립트가 붙기 전에 정의해 둬야 한다.
    window.navermap_authFailure = () =>
      fail(
        '네이버 지도 인증 실패 — 키가 유효한지, NCP 콘솔 Web 서비스 URL 에 현재 도메인이 등록됐는지 확인하세요',
        '지도 서비스 인증에 실패했습니다. 잠시 뒤 다시 시도해 주세요.',
      );

    const timer = setTimeout(
      () => fail(`네이버 지도 SDK 가 ${LOAD_TIMEOUT_MS / 1000}초 안에 뜨지 않았습니다`, '지도를 불러오는 데 시간이 너무 걸립니다.'),
      LOAD_TIMEOUT_MS,
    );

    const script = document.createElement('script');
    script.src = naverScriptUrl();
    script.async = true;
    script.onload = () => {
      // 인증 실패 콜백은 onload 와 같은 틱 또는 그 직후에 온다 — 한 틱 양보해 먼저 받는다.
      setTimeout(() => {
        if (settled) return;
        if (window.naver?.maps) done(() => resolve(window.naver));
        else fail('SDK 는 로드됐지만 naver.maps 를 찾을 수 없습니다', '지도를 불러오지 못했습니다.');
      }, 0);
    };
    script.onerror = () =>
      fail(
        '네이버 지도 SDK 로드 실패 — 네트워크 또는 차단 확장',
        '지도 스크립트를 불러오지 못했습니다. 네트워크나 광고 차단 확장을 확인해 주세요.',
      );
    document.head.appendChild(script);
  });

  return loadPromise;
}

/** 사용자에게 보여 줄 문구. 로더가 던진 것이 아니면 일반 문구 */
export function mapErrorMessage(e: unknown): string {
  return e instanceof NaverMapsLoadError ? e.userMessage : '지도를 불러오지 못했습니다.';
}
