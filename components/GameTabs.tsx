'use client';

import type { Board } from '@/lib/board-types';
import ScrollStrip from './ScrollStrip';

/**
 * 커뮤니티의 게임 탭 줄 — 리듬 기종 하나가 탭 하나입니다.
 *
 * 넘침(한 줄 스크롤 + 화살표)은 ScrollStrip 이 맡습니다. 여기 남는 것은 "무엇을
 * 늘어놓고 무엇이 켜져 있는가" 뿐입니다.
 *
 * `revealKey` 를 주는 이유: 상세를 열면 이 목록 화면이 통째로 사라졌다가 뒤로가기로
 * 다시 붙습니다 (components/CommunityView.tsx). 그때 스크롤은 0 으로 돌아가므로,
 * 오른쪽 끝의 기종을 고르고 글을 읽고 온 사람은 자기가 어느 탭에 있는지 못 보게 됩니다.
 */

interface Props {
  boards: Board[];
  /** null = '전체' 탭 */
  machineId: number | null;
  onSelect: (machineId: number | null) => void;
}

export default function GameTabs({ boards, machineId, onSelect }: Props) {
  return (
    <ScrollStrip
      as="nav"
      className="game-tabs"
      wrapClassName="game-tabs-wrap"
      // 탭은 fetch 로 늦게 온다 — 그때 다시 재야 화살표가 붙는다
      remeasureKey={boards.length}
      revealKey={machineId ?? 'all'}
    >
      <button
        type="button"
        className={machineId === null ? 'game-tab is-on' : 'game-tab'}
        onClick={() => onSelect(null)}
      >
        전체
      </button>
      {boards.map((b) => (
        <button
          key={b.machineId}
          type="button"
          className={machineId === b.machineId ? 'game-tab is-on' : 'game-tab'}
          title={b.name}
          onClick={() => onSelect(b.machineId)}
        >
          {b.shortName}
        </button>
      ))}
    </ScrollStrip>
  );
}
