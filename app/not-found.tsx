import Link from 'next/link';

export const metadata = {
  title: '페이지를 찾을 수 없습니다',
};

/** 없는 주소. Next 기본 404 는 브랜딩도 돌아갈 길도 없어 여기서 대신 그립니다 */
export default function NotFound() {
  return (
    <main className="login-page">
      <section className="login-card">
        <h1>이런 주소는 없어요</h1>
        <p className="muted small">
          주소가 바뀌었거나 잘못 적힌 것 같아요. 오락실은 지도에서, 글은 커뮤니티에서 다시
          찾아 주세요.
        </p>
        <div className="form-actions">
          <Link className="btn btn-primary btn-sm" href="/">
            오락실 파인더
          </Link>
          <Link className="btn btn-sm" href="/community">
            커뮤니티
          </Link>
        </div>
      </section>
    </main>
  );
}
