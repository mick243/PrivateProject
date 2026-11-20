import TierBoardView from '@/components/TierBoardView';

export const metadata = {
  title: '체감 난이도 서열표',
  description: '같은 레벨 채보를 클리어한 사람들의 체감 난이도 투표로 줄 세웠어요',
};

export default function Page() {
  return <TierBoardView />;
}
