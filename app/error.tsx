'use client';

import { useEffect } from 'react';

/**
 * 라우트 세그먼트 안에서 던져진 오류를 받는 경계 (Next: app/error.tsx).
 *
 * 2026-09-13 QA 전까지 이 파일이 없어서, 로더가 `data.games` 를 undefined 로 받아
 * `.map` 에서 터지면 Next 기본 "Application error" 흰 화면이 그대로 나갔습니다.
 * 배포 순단·DB 커넥션 이슈가 곧 화면 붕괴였습니다.
 *
 * 여기서는 원인을 보여 주지 않습니다 — 사용자가 고칠 수 있는 것이 아니고, 스택은
 * 정찰 자료입니다. 서버 로그에는 Next 가 이미 남깁니다. `digest` 만 표시해 문의할 때
 * 로그와 대조할 수 있게 합니다.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] 화면 오류 —', error);
  }, [error]);

  return (
    <main className="login-page">
      <section className="login-card" role="alert">
        <h1>화면을 불러오지 못했어요</h1>
        <p className="muted small">
          연결이 잠깐 끊겼거나 새 버전을 올리는 중일 수 있어요. 다시 시도해도 같으면 조금 뒤에
          들어와 주세요.
        </p>
        {error.digest && (
          <p className="muted small">
            오류 번호 <code>{error.digest}</code>
          </p>
        )}
        <button type="button" className="btn btn-primary btn-block" onClick={() => reset()}>
          다시 시도하기
        </button>
        <div className="link-row">
          <a className="btn-link" href="/">
            홈으로 가기
          </a>
        </div>
      </section>
    </main>
  );
}
