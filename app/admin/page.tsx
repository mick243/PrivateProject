import AdminConsole from '@/components/AdminConsole';

export const metadata = {
  title: '관리',
  // 관리자 전용 화면 — 검색 결과에 뜰 이유가 없습니다 (app/robots.ts 도 /admin 을 막습니다).
  robots: { index: false, follow: false },
};

/**
 * `/admin` — 관리자 전용. 신고함 · 계정 정지 · AI 기종 추정 검수.
 *
 * /admin/emoticons 와 같이 판정은 클라이언트 세션 스토어 + 서버 API 의 requireAdmin 두 겹입니다.
 * 페이지 자체는 정적이고, 데이터는 관리자 API(/api/admin/*)로만 받습니다.
 */
export default function Page() {
  return <AdminConsole />;
}
