'use client';

/**
 * 사이드바(검색칸 · 게임 칩 · 목록)와 지도 사이 경계에 붙어 있는 접기/펴기 손잡이.
 *
 * 사이드바 안(헤더 등)에 닫기 버튼을 두면 접은 뒤에 그 버튼도 같이 사라져서
 * 다시 여는 버튼을 따로 만들어야 합니다. 버튼이 둘이면 눌러야 할 곳이 상태에
 * 따라 화면 반대편으로 옮겨 다닙니다. 하나를 경계에 두면 접든 펴든 자리가
 * 그대로입니다 — 경계가 곧 사이드바의 오른쪽 끝이기 때문입니다.
 *
 * **글자를 붙입니다** (2026-11-20 사용성 시험 F-1). 꺾쇠 하나뿐이던 때('v' · '›', 64×20px)는
 * 목록 · 검색을 여는 단추로 읽히지 않아 처음 온 사람 대부분이 검색칸을 찾지 못했습니다.
 * 접혀 있을 때는 '목록 · 검색 열기', 펼쳐져 있을 때는 '목록 접기' 를 그대로 보여 줍니다.
 * 데스크톱에서 펼친 상태만은 칸 경계에 붙는 좁은 띠라 글자를 숨기고(.sidebar-handle-text)
 * 이름은 aria-label 로 남깁니다. 누를 수 있는 크기는 어느 상태든 44px 이상입니다 (CSS).
 *
 * 위치는 CSS 가 잡습니다 (app/globals.css 의 .sidebar-handle) — 상세 패널이
 * 열리면 사이드바 폭이 줄어드므로 폭을 변수(--sidebar-w) 한 곳에서 굴립니다.
 */
export default function SidebarHandle({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  /** 접었다 펴는 대상(사이드바)의 id — 스크린리더가 둘을 잇습니다 */
  controls: string;
}) {
  const label = open ? '목록 접기' : '목록 · 검색 열기';

  return (
    <button
      type="button"
      className={`sidebar-handle${open ? '' : ' is-off'}`}
      onClick={onToggle}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      title={label}
    >
      {/* 꺾쇠. 펴져 있으면 왼쪽(접는 방향), 접혀 있으면 오른쪽을 가리킵니다 —
          방향은 .is-off 에서 CSS 로 뒤집습니다. */}
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sidebar-handle-text" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}
