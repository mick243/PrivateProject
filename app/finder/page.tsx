import { Suspense } from 'react';
import ArcadeFinder from '@/components/ArcadeFinder';

export const metadata = {
  // layout 이 `%s — 오락실 파인더` 로 감싸므로 여기에 서비스 이름을 또 적으면
  // "오락실 파인더 — 오락실 파인더" 가 됩니다. 화면 이름만 적습니다.
  title: '오락실 찾기',
  description: '내 주변 오락실을 기종·영업시간으로 찾습니다',
};

export default function Page() {
  // ArcadeFinder 가 ?arcade=3 (실시간 피드에서 넘어온 링크) 를 읽으므로
  // useSearchParams 경계가 필요하다.
  return (
    <Suspense fallback={<p className="muted pad">불러오는 중…</p>}>
      <ArcadeFinder />
    </Suspense>
  );
}
