import Link from 'next/link';

export const metadata = {
  title: '페이지를 찾을 수 없어요',
};

/** 없는 주소. Next 기본 404 는 브랜딩도 돌아갈 길도 없어 여기서 대신 그립니다 */
export default function NotFound() {
  return (
    <main className="login-page">
      <section className="login-card">
        <h1>이런 주소는 없어요</h1>
        <p className="muted small">
          주소가 바뀌었거나 페이지가 없어졌을 수 있어요. 홈에서 오락실이나 글을 다시 찾아
          주세요.
        </p>
        {/* '/' 는 홈이다 (파인더는 /finder 로 옮겼다) — 예전 이름 '오락실 파인더' 는 맞지 않는다 */}
        <Link className="btn btn-primary btn-block" href="/">
          홈으로 가기
        </Link>
        <div className="link-row">
          <Link className="btn-link" href="/community">
            커뮤니티에서 찾기
          </Link>
        </div>
      </section>
    </main>
  );
}
