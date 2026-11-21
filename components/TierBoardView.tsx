'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { UNDECIDED_CODE, UNKNOWN_LEVEL } from '@/lib/tier-types';
import type { ChartDetail, ChartSummary, TierBoard, TierGame } from '@/lib/tier-types';
import { usePlayerId } from '@/lib/use-player';
import { parseTierQuery, sameSelection, tierQuery } from '@/lib/tier-url';
import type { TierSelection, TierUrlState } from '@/lib/tier-url';
import type { ChartSearchChart } from '@/lib/chart-search-types';
import TierSongSearch from './TierSongSearch';
import ScrollStrip from './ScrollStrip';
import ChartDetailPanel from './ChartDetailPanel';

interface LevelOption {
  /** null = 난이도 축인 게임 (사볼) → 레벨만으로 보드가 정해진다. migrate-045 */
  mode: string | null;
  /** null = 난이도 미상 채보들의 칸 (화면에 `?`). migrate-059 */
  level: number | null;
  chartCount: number;
}

/**
 * 요청하고 싶은 조합. versionId/mode/level 이 null 이면 "그 게임의 첫 조합" 을
 * 서버가 고릅니다. 화면에 실제로 그려진 조합은 board.versionId / board.mode /
 * board.level 이 유일한 출처입니다 — 요청값과 결과값을 양쪽에 두면 게임을 바꿀 때
 * 둘이 어긋납니다. 모양과 주소 규칙은 lib/tier-url.ts.
 */
type Selection = TierSelection;

/**
 * 주소에 실린 상태를 읽는다 (?machineId=3&level=17 · 모드가 있는 게임이면 &mode=S ·
 * 버전이 있는 게임이면 &versionId=1 · 채보 패널이 열려 있으면 &chart=123).
 *
 * useSearchParams 가 아니라 window.location 을 직접 읽습니다 — 그쪽을 쓰면 이
 * 페이지가 Suspense 경계를 요구해서, 얻는 것 없이 트리가 하나 더 생깁니다.
 */
function stateFromUrl(): TierUrlState {
  // 서버 렌더에는 주소가 없다. 이때 값이 갈리지만 첫 렌더 출력('불러오는 중…')은
  // sel 과 무관해서 하이드레이션이 어긋나지 않는다.
  if (typeof window === 'undefined') {
    return { sel: { machineId: null, versionId: null, mode: null, level: null }, chartId: null };
  }
  return parseTierQuery(window.location.search);
}

/**
 * 이 기록 칸이 "채보 패널을 연 것" 인가. 열 때 pushState 의 state 에 표시를 남깁니다 —
 * 그래야 닫기 · Esc 가 history.back() 으로 그 칸을 걷어 내, 뒤로 가기가 다시 패널을 열지
 * 않습니다. 공유 주소로 들어와 처음부터 열려 있던 패널은 표시가 없어 주소만 고칩니다.
 */
const PANEL_MARK = 'tierPanel';
function isPanelEntry(): boolean {
  const st = window.history.state as Record<string, unknown> | null;
  return Boolean(st && st[PANEL_MARK]);
}

/**
 * 서열표 칩에 띄우는 평균 투표 (소수점 2자리).
 *
 * `toFixed(2)` 만 쓰면 -0.004 가 **'-0.00'** 이 된다 — 있지도 않은 음수 0 이라
 * 읽는 사람이 "0 보다 낮은 건가?" 하고 멈춘다. 한 번 숫자로 되돌려 -0 을 없앤다.
 * 정렬 키(SQL ROUND(avg_vote,2))와 같은 값이라 표시와 순서가 어긋나지 않는다.
 */
function avgLabel(avg: number): string {
  return Number(avg.toFixed(2)).toFixed(2);
}

/**
 * 서열표 주소를 바꾼다. **push** 는 뒤로 가기로 돌아올 칸을 하나 더 쌓고, **replace** 는
 * 지금 칸을 고칩니다. `mark` 는 이 칸이 '채보 패널을 연 칸' 인지 (isPanelEntry).
 * 주소가 같으면 아무것도 쌓지 않습니다 — 같은 레벨을 다시 골라도 기록이 늘지 않게.
 */
function writeUrl(state: TierUrlState, how: 'push' | 'replace', mark: boolean) {
  const q = tierQuery(state);
  const next = `${window.location.pathname}${q ? `?${q}` : ''}`;
  const same = next === window.location.pathname + window.location.search;
  if (same && (how === 'push' || isPanelEntry() === mark)) return;
  // Next 16 은 history.pushState · replaceState 를 감싸 라우터와 맞춥니다
  // (node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md
  //  'Native History API'). 우리 표시 외의 내부 상태는 Next 가 옮겨 붙입니다.
  if (how === 'push') window.history.pushState({ [PANEL_MARK]: mark }, '', next);
  else window.history.replaceState({ [PANEL_MARK]: mark }, '', next);
}

export default function TierBoardView() {
  const playerId = usePlayerId();

  const [initial] = useState<TierUrlState>(stateFromUrl);
  const [sel, setSel] = useState<Selection>(initial.sel);
  const [games, setGames] = useState<TierGame[]>([]);
  const [levels, setLevels] = useState<LevelOption[]>([]);
  const [board, setBoard] = useState<TierBoard | null>(null);
  const [loading, setLoading] = useState(true);
  /** 서열표를 못 받았을 때의 문구. 예전엔 500 응답의 undefined 가 `.map` 에서 터져 흰 화면이었다 */
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * 열린 채보 — **주소의 `chart`** 와 같은 값입니다 (C-1). 상세 내용(detail)은 이 번호로
   * 따로 읽어 오므로, 주소만 있으면 새로고침 · 공유 · 뒤로 가기에서 같은 패널이 섭니다.
   */
  // 첫 값은 비워 두고 붙은 뒤에 주소에서 채운다 — 서버 렌더에는 주소가 없어, 처음부터 채우면
  // 오른쪽 칸의 첫 출력(안내문 ↔ '불러오는 중…')이 서버와 달라져 하이드레이션이 어긋난다.
  const [chartId, setChartId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ChartDetail | null>(null);
  /** 열린 채보를 못 읽었을 때의 문구 — 어느 채보의 것인지 함께 둔다 */
  const [detailError, setDetailError] = useState<{ id: number; message: string } | null>(null);
  /**
   * 패널 제목으로 초점을 옮기라는 신호 (C-3). 사용자가 **눌러서** 연 채보의 상세가 도착했을
   * 때만 올립니다 — 공유 주소로 들어와 처음부터 열린 패널은 초점을 빼앗지 않습니다.
   */
  const [focusToken, setFocusToken] = useState(0);
  const focusPendingRef = useRef<number | null>(null);
  /** 패널이 닫힌 뒤 초점을 돌려줄 칩의 채보 번호 */
  const returnFocusRef = useRef<number | null>(null);
  /** 검색 · 다른 채보 링크로 고른 채보 — 그 표가 그려지면 칩이 보이게 굴린다 */
  const scrollPendingRef = useRef<number | null>(null);
  const chartIdRef = useRef<number | null>(null);
  useEffect(() => {
    const fromUrl = parseTierQuery(window.location.search).chartId;
    if (fromUrl !== null) setChartId(fromUrl);
  }, []);
  useEffect(() => {
    chartIdRef.current = chartId;
  }, [chartId]);
  /** 늦게 도착한 앞선 응답이 새 표를 덮지 않게 (레벨을 빠르게 넘길 때) */
  const loadSeq = useRef(0);

  const loadBoard = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sel.machineId !== null) params.set('machineId', String(sel.machineId));
      if (sel.versionId !== null) params.set('versionId', String(sel.versionId));
      if (sel.mode !== null) params.set('mode', sel.mode);
      if (sel.level !== null) params.set('level', String(sel.level));

      const res = await fetch(`/api/tier?${params}`);
      const data = await res.json().catch(() => ({}));
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? '서열표를 불러오지 못했어요.');
      setGames((data.games as TierGame[]) ?? []);
      setLevels((data.levels as LevelOption[]) ?? []);
      setBoard((data.board as TierBoard) ?? null);
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // fetch 가 던지는 TypeError 의 message 는 브라우저 문구('Failed to fetch')라 화면에 내지 않는다
      setLoadError(
        e instanceof Error && !(e instanceof TypeError)
          ? e.message
          : '연결이 잠깐 끊겼어요. 다시 시도해 주세요',
      );
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // playerId 는 요청에 쓰이지 않지만 **의존성에는 남깁니다**. 내 클리어·투표
    // 표시는 서버가 세션에서 읽으므로, 로그인한 사람이 바뀌면 같은 주소라도
    // 응답이 달라집니다 — 빼면 앞사람의 표시가 그대로 남습니다.
  }, [sel, playerId]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  /**
   * 그려진 조합으로 주소를 **고친다**(replace) — 새로고침하면 보던 서열표가 그대로 나온다.
   *
   * 요청값(sel)이 아니라 **board** 를 씁니다. sel 은 게임만 고르고 모드·레벨은
   * 비워 두는 경우가 있어(그 게임의 첫 조합을 서버가 고른다), sel 을 주소에
   * 적으면 새로고침했을 때 레벨이 빠진 주소가 되어 다시 첫 조합으로 갑니다.
   *
   * 기록을 **쌓는** 일은 사용자가 고를 때(choose · openChart) 합니다 — 2026-11-20 UX 시험에서
   * 레벨을 바꿔도 기록이 늘지 않아 뒤로 가기가 곧장 홈으로 나갔습니다(C-1). 여기서는 그
   * 칸의 주소를 서버가 고른 조합으로 다듬기만 하므로 replace 가 맞습니다. 열린 채보는
   * 주소에 있는 그대로 둡니다.
   */
  useEffect(() => {
    if (!board) return;
    const { chartId: openId } = parseTierQuery(window.location.search);
    writeUrl(
      {
        sel: {
          machineId: board.game.machineId,
          versionId: board.versionId,
          mode: board.mode,
          level: board.level === null ? UNKNOWN_LEVEL : board.level,
        },
        chartId: openId,
      },
      'replace',
      isPanelEntry(),
    );
  }, [board]);

  /** 뒤로 · 앞으로 가기 — 주소를 다시 읽어 표와 패널을 맞춘다 */
  useEffect(() => {
    const onPop = () => {
      const st = parseTierQuery(window.location.search);
      if (chartIdRef.current !== null && st.chartId === null) {
        returnFocusRef.current = chartIdRef.current;
      }
      setSel((prev) => (sameSelection(prev, st.sel) ? prev : st.sel));
      setChartId(st.chartId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * 열린 채보의 상세를 읽는다. 로그인한 사람이 바뀌어도 다시 읽는다 — 내 클리어·투표
   * 표시가 그 사람 기준이다 (playerId 를 보내지는 않는다. 서버가 세션에서 읽는다).
   */
  useEffect(() => {
    if (chartId === null) return;
    let live = true;
    fetch(`/api/charts/${chartId}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok && data.chart) {
          setDetail(data.chart as ChartDetail);
          setDetailError(null);
          if (focusPendingRef.current === chartId) {
            focusPendingRef.current = null;
            setFocusToken((t) => t + 1);
          }
        } else {
          setDetailError({
            id: chartId,
            message: data.error ?? '채보를 불러오지 못했어요. 다시 시도해 주세요',
          });
        }
      })
      .catch(() => {
        if (live) setDetailError({ id: chartId, message: '연결이 잠깐 끊겼어요. 다시 시도해 주세요' });
      });
    return () => {
      live = false;
    };
  }, [chartId, playerId]);

  /** 패널이 닫히면 그 패널을 연 칩으로 초점을 돌려준다 (C-3) */
  useEffect(() => {
    if (chartId !== null || returnFocusRef.current === null) return;
    const id = returnFocusRef.current;
    returnFocusRef.current = null;
    document.querySelector<HTMLElement>(`[data-chart-id="${id}"]`)?.focus();
  }, [chartId]);

  /** 검색 · 다른 채보 링크로 건너온 칩을 화면 안으로 굴린다 — 표가 그려진 뒤에 */
  useEffect(() => {
    const id = scrollPendingRef.current;
    if (id === null) return;
    const chip = document.querySelector<HTMLElement>(`[data-chart-id="${id}"]`);
    if (!chip) return; // 아직 앞 표다 — 새 표가 오면 다시 본다
    scrollPendingRef.current = null;
    chip.scrollIntoView({ block: 'center' });
  }, [board, chartId]);

  /**
   * 게임 · 버전 · 모드 · 레벨을 고른다 — 뒤로 가기로 돌아올 칸을 쌓는다 (C-1).
   *
   * 1초 안에 잇따라 고르면 새 칸을 쌓지 않고 방금 칸을 고칩니다. 닫힌 셀렉트에서 ↓ 를
   * 누르면 한 칸마다 change 가 나서(S1 → S20 이 19번), 그대로 쌓으면 뒤로 가기를 19번
   * 눌러야 합니다. 마지막에 멈춘 레벨 하나만 남습니다.
   */
  const lastChooseAt = useRef(0);
  const choose = (next: Selection) => {
    const now = Date.now();
    const how = now - lastChooseAt.current < 1000 ? 'replace' : 'push';
    lastChooseAt.current = now;
    writeUrl({ sel: next, chartId: parseTierQuery(window.location.search).chartId }, how, false);
    setSel(next);
  };

  /** 칩을 눌러 채보를 연다. 닫혀 있었으면 기록을 쌓아 뒤로 가기가 패널을 닫게 한다 */
  const openChart = (id: number) => {
    if (chartId === id) {
      // 이미 열린 채보 — 초점만 패널로 옮긴다
      setFocusToken((t) => t + 1);
      return;
    }
    focusPendingRef.current = id;
    const cur = parseTierQuery(window.location.search);
    if (chartId === null) writeUrl({ ...cur, chartId: id }, 'push', true);
    else writeUrl({ ...cur, chartId: id }, 'replace', isPanelEntry());
    setChartId(id);
  };

  /** 닫기 · Esc. 연 칸이 쌓여 있으면 그 칸을 걷어 내고(뒤로 가기와 같은 결과), 아니면 주소만 고친다 */
  const closePanel = () => {
    returnFocusRef.current = chartId;
    if (isPanelEntry()) {
      window.history.back(); // popstate 가 chartId 를 비운다
      return;
    }
    writeUrl({ ...parseTierQuery(window.location.search), chartId: null }, 'replace', false);
    setChartId(null);
  };

  const handleChanged = (chart: ChartDetail) => {
    setDetail(chart);
    void loadBoard(); // 등급이 바뀌었을 수 있으므로 서열표를 다시 계산해 받는다
  };

  /**
   * 검색 결과 · '이 곡의 다른 채보' 에서 채보 하나를 고른다 — 그 채보의 표로 건너가고
   * 패널을 그 채보로 연다. 기록을 쌓으므로 뒤로 가기로 보던 표로 돌아온다.
   *
   * 패널 표시(mark)는 남기지 않습니다 — 건너온 표에서 패널을 닫으면 그 표에 머무는 것이
   * 맞고, 닫기가 history.back() 으로 앞 표까지 되돌리면 안 됩니다.
   */
  const jumpToChart = (c: ChartSearchChart) => {
    if (!board) return;
    const next: Selection = {
      machineId: board.game.machineId,
      versionId: c.versionId,
      // 난이도 축인 게임(사볼)은 레벨만으로 표가 정해진다 — 모드를 보내지 않는다
      mode: board.settings.modeIsDifficulty ? null : c.mode,
      level: c.level ?? UNKNOWN_LEVEL,
    };
    focusPendingRef.current = c.id;
    scrollPendingRef.current = c.id;
    writeUrl({ sel: next, chartId: c.id }, 'push', false);
    setSel((prev) => (sameSelection(prev, next) ? prev : next));
    setChartId(c.id);
  };

  /** 지금 보이는 상세 — 닫혔으면 없다. 다른 채보로 바꾸는 동안에는 앞 채보를 그대로 둔다 */
  const shownDetail = chartId === null ? null : detail;
  const shownError = chartId !== null && detailError?.id === chartId ? detailError.message : null;

  /**
   * 등급 칸(anchor 가 있는 칸)에 실제로 놓인 채보 수. 개인차·특수패턴·미정은 세지
   * 않는다 — 그 셋은 "줄을 세운 결과" 가 아니라 "줄을 못 세운 것" 이기 때문이다.
   */
  const placedCount =
    board?.groups.reduce((n, g) => (g.anchor !== null ? n + g.charts.length : n), 0) ?? 0;
  const undecidedCount =
    board?.groups.find((g) => g.code === UNDECIDED_CODE)?.charts.length ?? 0;

  // 실제로 그려진 조합 기준으로 컨트롤을 맞춘다.
  // 미상 칸은 <option value> 가 숫자가 아니라 UNKNOWN_LEVEL 이다.
  const activeLevel = board ? (board.level ?? UNKNOWN_LEVEL) : '';
  const labelOf = (code: string) =>
    board?.game.modes.find((m) => m.code === code)?.label ?? code;

  /**
   * 버전을 구분하는 게임(EZ2DJ)에만 선택기를 그린다 — 펌프·사볼은 빈 배열이라
   * 아무것도 그려지지 않는다 (migrate-059 · 모드 선택기와 같은 방식).
   */
  const versions = board?.game.versions ?? [];

  /**
   * 어느 보드인가를 사람이 읽는 말로 — `7 Street Lv.3`.
   *
   * 모드는 코드(`7ST`)가 아니라 **표기**(`7 Street`)를 씁니다. 코드는 주소와 DB 의
   * 열쇠일 뿐이고, 화면에서는 게임이 부르는 이름이 보여야 합니다.
   * 모드 축이 없는 게임(사볼)은 레벨만, 레벨을 모르는 칸은 `Lv.?` 입니다.
   */
  const modeLevelLabel = (mode: string | null, level: number | null): string =>
    [mode === null ? null : labelOf(mode), `Lv.${level ?? '?'}`].filter(Boolean).join(' ');

  /**
   * 제목 = 게임 · (버전) · 모드+레벨. 버전이 없는 게임은 그 자리가 통째로 빠진다.
   */
  const boardTitle = board
    ? [board.game.name, board.versionLabel, modeLevelLabel(board.mode, board.level)]
        .filter(Boolean)
        .join(' ')
    : // 아래 h1 이 뒤에 '서열표' 를 붙인다 — 여기도 '서열표' 면 "서열표 서열표" 가 된다
      '체감 난이도';

  /**
   * 사볼의 NOV/ADV/EXH/MXM 은 모드가 아니라 난이도다 (migrate-045).
   * 그런 게임은 레벨만으로 보드가 정해지므로 모드 버튼을 그리지 않고,
   * 난이도는 곡명 뒤 대괄호로 보여준다. 펌프의 Single/Double 은 그대로 버튼.
   *
   * 서버가 levels 의 mode 를 null 로 내려주는 것으로 이 구분을 알린다 —
   * board 가 아직 없을 때(첫 로딩)도 컨트롤을 맞춰야 하므로 settings 를 안 본다.
   */
  const modeIsDifficulty = levels.length > 0 && levels.every((l) => l.mode === null);
  const activeMode = board?.mode ?? '';
  const modeCodes = modeIsDifficulty
    ? []
    : [...new Set(levels.map((l) => l.mode).filter((m): m is string => m !== null))];
  const levelsForMode = modeIsDifficulty
    ? levels
    : levels.filter((l) => l.mode === activeMode);

  /**
   * 칩의 대괄호 — 한 보드에 여러 채보가 섞일 때 어느 것인지 밝힌다.
   *
   *   난이도 축이 있는 게임(EZ2DJ)     → charts.difficulty  (`[H]`)
   *   모드 축이 난이도인 게임(사볼)     → charts.mode        (`[MXM]`, migrate-045)
   *
   * 둘 다 없으면(펌프) 붙일 것이 없어 빈 대괄호를 그리지 않는다.
   */
  const diffMark = (c: ChartSummary): string | null =>
    c.difficulty ?? (modeIsDifficulty ? c.mode : null);

  /**
   * 등급 색은 코드가 아니라 '위에서 몇 번째'로 정한다 (globals.css .tier-r*).
   * 코드로 칠하면 사볼 s(최상)와 펌프 s(위에서 둘째)가 같은 색이 되어 버린다.
   *
   * groups 는 [등급… , 개인차, 특수패턴, 미정] 순이고, 뒤의 셋은 등급이 아니라
   * 표시라서 anchor 가 없다 — 그걸로 등급 개수를 센다 (lib/tier.ts getTierBoard).
   * 맨 아래 등급은 언제나 회색(tier-rlast) 이라, 단계 수가 다른 게임끼리도
   * 위는 빨강 · 아래는 회색으로 끝이 맞는다.
   */
  const gradeCount = board?.groups.filter((g) => g.anchor !== null).length ?? 0;
  const rankClass = (i: number) => {
    if (i >= gradeCount) return ''; // 개인차 · 특수패턴 · 미정 — 자기 색이 따로 있다
    return i === gradeCount - 1 ? 'tier-rlast' : `tier-r${i + 1}`;
  };

  return (
    <div className="tier-layout">
      <section className="tier-main">
        <header className="tier-head">
          <div>
            <h1>{boardTitle} 서열표</h1>
            {/* 채보 목록의 기준 버전. 게임마다 다르고 없을 수도 있어 DB 가 들고 있다
                (tier_settings.chart_basis · migrate-044). 없으면 줄을 그리지 않는다. */}
            {board?.settings.chartBasis && (
              <p className="tier-basis muted">
                채보 목록은 {board.settings.chartBasis} 기준이에요.
              </p>
            )}
            <p className="muted small">
              같은 레벨 채보를 <strong>클리어한 사람들</strong>의 체감 난이도 투표로 줄 세웠어요.
              채보를 누르면 평가를 보고 투표할 수 있어요.
            </p>
          </div>

          {/*
            게임 탭·말머리와 같이 한 줄로 두고 옆으로 민다 (components/ScrollStrip.tsx).
            선택기 넷이 좁은 화면에서 접히면 그 아래 서열표가 그만큼 내려가는데,
            이 줄은 표의 머리라 자리가 고정돼야 읽기 편하다.

            remeasureKey 가 긴 이유: 이 줄은 항목 **수**만 바뀌는 게 아니라 폭도 바뀐다
            (셀렉트가 width:auto 라 고른 항목의 글자 길이가 곧 폭이다 — '7 Street').
            버전·모드 선택기는 그 축이 없는 게임에서 통째로 사라지기도 한다.
            고르는 값이 여러 개라 revealKey 는 주지 않는다.
          */}
          <ScrollStrip
            className="tier-controls"
            remeasureKey={`${activeMode}:${activeLevel}:${modeCodes.length}:${levelsForMode.length}:${versions.length}:${games.length}`}
          >
            <select
              value={board?.game.machineId ?? ''}
              onChange={(e) =>
                // 게임을 바꾸면 버전·모드·레벨은 비운다. 그 게임에 있는 첫 조합을 서버가 고른다.
                choose({
                  machineId: Number(e.target.value),
                  versionId: null,
                  mode: null,
                  level: null,
                })
              }
              title="서열표가 있는 게임"
              aria-label="게임"
            >
              {games.map((g) => (
                <option key={g.machineId} value={g.machineId}>
                  {g.name}
                </option>
              ))}
            </select>

            {/* 버전을 구분하지 않는 게임에는 이 선택기가 없다 (versions 가 빈 배열) */}
            {versions.length > 0 && (
              <select
                value={board?.versionId ?? ''}
                onChange={(e) =>
                  // 버전마다 있는 (모드, 레벨) 조합이 다르므로 둘은 비운다.
                  choose({
                    machineId: board?.game.machineId ?? sel.machineId,
                    versionId: Number(e.target.value),
                    mode: null,
                    level: null,
                  })
                }
                title="채보 목록의 기준 버전"
                aria-label="버전"
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            )}

            {/* 난이도 축인 게임에는 모드 선택기가 없다 (modeCodes 가 빈 배열) */}
            {modeCodes.length > 0 && (
              <select
                value={activeMode}
                onChange={(e) =>
                  // 모드마다 있는 레벨이 다르므로 레벨은 비운다.
                  choose({
                    machineId: board?.game.machineId ?? sel.machineId,
                    versionId: board?.versionId ?? sel.versionId,
                    mode: e.target.value,
                    level: null,
                  })
                }
                title="플레이 모드"
                aria-label="플레이 모드"
              >
                {modeCodes.map((m) => (
                  <option key={m} value={m}>
                    {labelOf(m)}
                  </option>
                ))}
              </select>
            )}

            <select
              value={activeLevel}
              onChange={(e) =>
                choose({
                  machineId: board?.game.machineId ?? sel.machineId,
                  versionId: board?.versionId ?? sel.versionId,
                  mode: modeIsDifficulty ? null : activeMode,
                  level:
                    e.target.value === UNKNOWN_LEVEL ? UNKNOWN_LEVEL : Number(e.target.value),
                })
              }
              aria-label="레벨"
            >
              {levelsForMode.map((l) => (
                <option key={l.level ?? UNKNOWN_LEVEL} value={l.level ?? UNKNOWN_LEVEL}>
                  {/* 모드는 바로 왼쪽 선택기가 이미 말하고 있으므로 레벨만 적는다.
                      레벨을 모르는 칸은 숫자 자리에 `?` 를 세운다 (migrate-059). */}
                  Lv.{l.level ?? '?'} · {l.chartCount}곡
                </option>
              ))}
            </select>
          </ScrollStrip>

          {/* 레벨을 몰라도 곡 이름으로 찾는다 — 이 게임의 모든 레벨에서 (T-1) */}
          {board && (
            <TierSongSearch
              // 게임 · 버전을 바꾸면 앞 게임의 검색어와 결과를 걷는다
              key={`${board.game.machineId}:${board.versionId ?? ''}`}
              game={board.game}
              versionId={board.versionId}
              onPick={jumpToChart}
            />
          )}
        </header>

        {loadError ? (
          <p className="warn pad" role="alert">
            {loadError}{' '}
            <button type="button" className="btn btn-sm" onClick={() => void loadBoard()}>
              다시 불러오기
            </button>
          </p>
        ) : loading && !board ? (
          <p className="muted pad">불러오는 중…</p>
        ) : !board ? (
          <p className="muted pad">이 게임은 아직 채보 목록이 없어요. 위에서 다른 게임을 골라 주세요.</p>
        ) : (
          <div className="tier-rows">
            {board.groups.map((g, i) => (
              <div
                key={g.code}
                className={`tier-row tier-${g.code} ${rankClass(i)} ${
                  g.charts.length === 0 ? 'is-empty' : ''
                }`}
              >
                <div className="tier-label">
                  <strong>{g.label}</strong>
                  <span className="muted small">
                    {g.anchor !== null ? g.anchor.toFixed(2) : ''} · {g.charts.length}곡
                  </span>
                </div>

                <div className="tier-charts">
                  {g.charts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`chart-chip ${chartId === c.id ? 'is-on' : ''}`}
                      data-chart-id={c.id}
                      aria-current={chartId === c.id ? 'true' : undefined}
                      onClick={() => openChart(c.id)}
                      title={[
                        `${c.voteCount}표`,
                        c.myVote !== null ? `내 투표 ${c.myVote.toFixed(1)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    >
                      {c.myClear && <i className="clear-mark" title="내가 클리어한 채보" />}
                      <span className="chip-title">
                        {c.title}
                        {/* 한 보드에 여러 채보가 섞이는 게임은 어느 것인지 곡명 뒤에
                            대괄호로 밝힌다 (예: [MXM] · [HD]). 규칙은 diffMark. */}
                        {diffMark(c) !== null && (
                          <span className="chip-diff"> [{diffMark(c)}]</span>
                        )}
                      </span>
                      {/* 칩에는 평균 투표를 띄운다 — 줄 세우기의 근거가 눈에 보여야
                          어떤 순서인지 알 수 있다. 정렬도 이 값(2자리) 기준이다.
                          내 투표는 툴팁으로 옮겼다. */}
                      {c.avgVote !== null && (
                        <em className="chip-vote">{avgLabel(c.avgVote)}</em>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {board && (
          <footer className="tier-foot muted small">
            {/*
              등급 칸에 놓인 채보가 하나도 없을 때의 안내.

              이 상태는 화면에서 **모순으로 보인다** — 위 레벨 선택은 "S1 · 18곡" 이라고
              하는데 등급은 여덟 칸이 모두 "0곡" 이다. 18곡이 전부 '미정' 에 있어서인데,
              그 사실이 어디에도 적혀 있지 않아 고장으로 읽혔다 (2026-09-13 UX 점검).
              서열표는 투표로 서는 표라, 여기가 비어 있다는 건 투표를 부탁할 자리다.

              2026-09-15 에 표 위에서 이 자리로 내렸다. 등급 칸과 '미정' 을 다 본 뒤에
              읽는 설명이 되므로, 읽는 사람이 이미 본 것을 가리키게 된다.
            */}
            {placedCount === 0 && (
              <p className="tier-foot-empty" role="status">
                {/*
                  ⚠ '아래' → '위', '이 자리' → '등급 칸' 으로 두 낱말만 고쳤습니다.
                  표 위에 있을 때는 '미정' 이 아래였고 빈 등급 칸이 바로 그 자리였는데,
                  푸터로 내려오면서 둘 다 방향이 뒤집혔습니다. 원래 문장을 그대로 두면
                  화면이 위를 가리키며 "아래" 라고 말하게 됩니다.
                */}
                {undecidedCount > 0
                  ? `아직 투표가 모이지 않아 ${undecidedCount}곡이 위 ‘미정’ 칸에 있어요.`
                  : '아직 등급 칸에 놓인 채보가 없어요.'}{' '}
                클리어한 채보를 눌러 투표하면 등급 칸에 줄이 서요.
              </p>
            )}
            {/* 판정 규칙은 줄이지 않는다 — 왜 '미정' · '개인차' 에 있는지 읽는 사람이 알아야 한다.
                말만 쉽게, 두 문장으로 (DESIGN-GUIDE §1-1 · §5 수렴도 → 의견 일치도). */}
            {[board.game.name, board.versionLabel, modeLevelLabel(board.mode, board.level)]
              .filter(Boolean)
              .join(' ')}{' '}
            · 총 {board.totalCharts}곡. 투표가 {board.settings.minVotes}표보다 적으면
            &lsquo;미정&rsquo;, 의견 일치도가 {board.settings.minConvergence}보다 낮으면
            &lsquo;개인차&rsquo; 칸에 놓여요. 투표는 {board.settings.voteMin.toFixed(1)} ~{' '}
            {board.settings.voteMax.toFixed(1)} 사이로 하고, 등급 기준은 게임마다 달라요.
          </footer>
        )}
      </section>

      <aside className="tier-side">
        {shownError ? (
          // 주소의 채보를 못 읽었을 때 — 지워졌거나 번호가 틀린 공유 주소. 닫을 길을 둔다.
          <div className="detail-empty">
            <p className="warn" role="alert">
              {shownError}
            </p>
            <button type="button" className="btn btn-sm" onClick={closePanel}>
              닫기
            </button>
          </div>
        ) : shownDetail ? (
          <ChartDetailPanel
            chart={shownDetail}
            playerId={playerId}
            game={board?.game ?? null}
            focusToken={focusToken}
            onChanged={handleChanged}
            onClose={closePanel}
            onPickChart={jumpToChart}
          />
        ) : chartId !== null ? (
          <p className="detail-empty muted">채보를 불러오는 중…</p>
        ) : (
          <div className="detail-empty muted">
            <p>채보를 누르면 투표 분포와 평가를 보고, 체감 난이도를 투표할 수 있어요.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
