import { Suspense } from 'react';
import VerifyEmailPanel from '@/components/VerifyEmailPanel';

export const metadata = {
  title: '이메일 확인',
  description: '가입할 때 적은 이메일 주소가 내 것인지 확인해요',
};

export default function Page() {
  // VerifyEmailPanel 이 ?status=… (인증 라우트가 넘겨주는 결과) 를 읽으므로
  // useSearchParams 경계가 필요하다 (/welcome · /account 와 같은 이유).
  return (
    <Suspense fallback={<p className="muted pad">불러오는 중…</p>}>
      <VerifyEmailPanel />
    </Suspense>
  );
}
