import { Suspense } from 'react';
import ResetPasswordForm from '@/components/ResetPasswordForm';

export const metadata = {
  title: '새 비밀번호 정하기',
  description: '메일로 받은 링크로 새 비밀번호를 정해요',
  // 토큰이 든 주소가 검색에 잡힐 일은 없지만, 이 화면 자체를 색인할 이유도 없습니다.
  robots: { index: false, follow: false },
  // 링크의 토큰이 다른 사이트로 Referer 에 실려 가지 않게 (화면이 주소창에서도 곧바로 지웁니다)
  referrer: 'no-referrer',
};

export default function Page() {
  // ResetPasswordForm 이 ?token= 을 읽으므로 useSearchParams 경계가 필요하다.
  return (
    <Suspense fallback={<p className="muted pad">불러오는 중…</p>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
