export const metadata = {
  title: '오프라인',
  robots: { index: false },
};

/**
 * 네트워크가 없을 때 서비스 워커(public/sw.js)가 대신 보여 주는 화면.
 *
 * 설치할 때 미리 캐시되므로 **서버 없이 그려져야** 합니다 — 데이터를 가져오지 않고,
 * 스크립트에 기대지 않는 정적 문구만. 링크는 다시 시도할 때 쓰는 새로고침입니다.
 */
export default function OfflinePage() {
  return (
    <main className="login-page">
      <section className="login-card" role="status">
        <h1>지금은 오프라인이에요</h1>
        <p className="muted small">
          오락실 지도와 제보는 서버에서 바로 받아 오는 정보라, 네트워크가 돌아오면 다시 볼 수
          있어요. 데이터 연결을 확인한 뒤 새로고침해 주세요.
        </p>
        <div className="form-actions">
          <a className="btn btn-primary btn-sm" href="/">
            다시 시도
          </a>
        </div>
      </section>
    </main>
  );
}
