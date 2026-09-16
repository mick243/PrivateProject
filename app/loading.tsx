/**
 * 세그먼트 전환 중 보이는 자리. 각 화면이 자기 로딩 문구를 따로 갖고 있어 여기는
 * 가장 얇게 — 상단 네비는 레이아웃에 있어 그대로 남고, 본문만 이 문구로 바뀝니다.
 */
export default function Loading() {
  return (
    <p className="muted pad" role="status" aria-live="polite">
      불러오는 중…
    </p>
  );
}
