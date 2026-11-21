import { Suspense } from 'react';
import ForgotPasswordForm from '@/components/ForgotPasswordForm';

export const metadata = {
  title: '비밀번호 찾기',
  description: '확인을 마친 이메일로 새 비밀번호를 정하는 링크를 받아요',
};

export default function Page() {
  // ForgotPasswordForm 이 ?next= · ?id= 를 읽으므로 useSearchParams 경계가 필요하다 (/login 과 같은 이유).
  return (
    <Suspense fallback={<p className="muted pad">불러오는 중…</p>}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
