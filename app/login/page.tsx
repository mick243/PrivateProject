import { Suspense } from 'react';
import LoginForm from '@/components/LoginForm';

export const metadata = {
  title: '로그인',
  description: '아이디와 비밀번호, 또는 소셜 계정으로 로그인해요',
};

export default function Page() {
  // LoginForm 이 ?next=… (로그인 뒤 돌아갈 곳) 를 읽으므로
  // useSearchParams 경계가 필요하다.
  return (
    <Suspense fallback={<p className="muted pad">불러오는 중…</p>}>
      <LoginForm />
    </Suspense>
  );
}
