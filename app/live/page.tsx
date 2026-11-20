import LiveFeed from '@/components/LiveFeed';

export const metadata = {
  title: '실시간 제보',
  description: '게임별 대기 인원, 기계 상태, 게임 들어옴·빠짐 제보를 한 화면에서 봐요',
};

export default function Page() {
  return <LiveFeed />;
}
