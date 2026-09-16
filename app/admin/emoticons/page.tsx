import EmoticonAdmin from '@/components/EmoticonAdmin';

export const metadata = {
  title: '이모티콘 관리',
  // 관리자 전용 화면 — 검색 결과에 뜰 이유가 없습니다 (app/robots.ts 도 /admin 을 막습니다).
  robots: { index: false, follow: false },
};

/**
 * `/admin/emoticons` — 관리자 전용.
 *
 * 다른 화면(/account 등)과 같이 판정은 클라이언트 세션 스토어 + 서버 API 의
 * requireAdmin 두 겹입니다. 이 페이지 자체는 정적으로 만들어지고 데이터는
 * 내려온 뒤 관리자 API 로만 받으므로, 페이지 HTML 에 관리 정보가 실리는 일은 없습니다.
 */
export default function Page() {
  return <EmoticonAdmin />;
}
