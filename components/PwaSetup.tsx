'use client';

import { useEffect, useState } from 'react';

/**
 * 설치형 웹앱(PWA) 클라이언트 쪽 — 서비스 워커 등록 + 설치 안내 배너.
 *
 * ─── 등록 ───
 * 운영 빌드에서만 등록합니다. dev 서버에서 워커가 붙으면 HMR 과 캐시가 엉켜
 * "고쳤는데 안 바뀐다" 가 됩니다. 등록 실패는 조용히 넘깁니다 — 워커는 있으면 좋은 것이고
 * 없어도 앱은 그대로 돕니다.
 *
 * ─── 설치 안내 ───
 * Android/Chrome 계열은 `beforeinstallprompt` 를 가로채 "앱으로 설치" 버튼으로 바꿉니다
 * (브라우저 기본 미니 인포바는 놓치기 쉽습니다). iOS Safari 는 그런 이벤트가 없어서,
 * 아직 홈 화면이 아닐 때 한 줄로 방법만 알려 줍니다. 닫으면 30일간 다시 묻지 않습니다
 * (localStorage — 기기마다, 조용히 실패해도 무해).
 *
 * 이미 설치된 상태(display-mode: standalone)에서는 아무것도 그리지 않습니다.
 */

const DISMISS_KEY = 'pwa-install-dismissed-at';
const DISMISS_DAYS = 30;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari 전용 플래그
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) && !(window as Window & { MSStream?: unknown }).MSStream;
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return ios && safari;
}

function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export default function PwaSetup() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.warn('[pwa] 서비스 워커 등록 실패 —', e instanceof Error ? e.message : e);
      });
    }

    if (isStandalone() || recentlyDismissed()) return;
    setHidden(false);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    // iOS 는 이벤트가 없다 — 첫 방문에는 지도가 먼저 보여야 하므로 조금 뒤에 띄운다
    const iosTimer = isIosSafari() ? setTimeout(() => setShowIosHint(true), 8000) : null;
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      if (iosTimer) clearTimeout(iosTimer);
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* 저장 안 돼도 이번 세션은 닫힌다 */
    }
    setHidden(true);
  };

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') setHidden(true);
    setInstallEvent(null);
  };

  if (hidden) return null;
  if (!installEvent && !showIosHint) return null;

  return (
    <div className="pwa-banner" role="complementary" aria-label="앱 설치 안내">
      <span className="pwa-banner-icon" aria-hidden="true">
        📍
      </span>
      {installEvent ? (
        <>
          <span className="pwa-banner-text">
            <strong>앱으로 설치</strong>하면 홈 화면에서 바로 열 수 있어요.
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void install()}>
            설치
          </button>
        </>
      ) : (
        <span className="pwa-banner-text">
          Safari 아래 <strong>공유</strong> 버튼 → <strong>홈 화면에 추가</strong>로 앱처럼 쓸 수 있어요.
        </span>
      )}
      <button type="button" className="pwa-banner-close" aria-label="닫기" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
