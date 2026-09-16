'use client';

/**
 * 루트 레이아웃 자체가 실패했을 때의 마지막 경계 (Next: app/global-error.tsx).
 * 레이아웃을 대신하므로 <html>/<body> 를 스스로 그려야 하고, globals.css 도 이미
 * 실패한 상태일 수 있어 스타일을 인라인으로 둡니다.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#0f1218',
          color: '#e6e8ef',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <main style={{ maxWidth: 360, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>오락실 파인더를 불러오지 못했습니다</h1>
          <p style={{ fontSize: 14, opacity: 0.75, margin: '0 0 16px' }}>
            잠시 뒤 다시 시도해 주세요.
            {error.digest ? ` (오류 번호 ${error.digest})` : ''}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: 0,
              background: '#6d5efc',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            다시 시도
          </button>
        </main>
      </body>
    </html>
  );
}
