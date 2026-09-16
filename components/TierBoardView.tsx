'use client';

import { useCallback, useEffect, useState } from 'react';
import { UNDECIDED_CODE, UNKNOWN_LEVEL } from '@/lib/tier-types';
import type { ChartDetail, ChartSummary, TierBoard, TierGame } from '@/lib/tier-types';
import { usePlayerId } from '@/lib/use-player';
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
 * 둘이 어긋납니다.
 */
interface Selection {
  machineId: number | null;
  versionId: number | null;
  mode: string | null;
  /**
   * 숫자 = 그 레벨 · `UNKNOWN_LEVEL` = 난이도 미상 칸 · null = 서버가 고른다.
   * 셋을 구분해야 해서 null 하나로 합칠 수 없습니다 — '고르지 않음' 과 '모름' 은
   * 다른 뜻이고, 뒤엣것도 사용자가 **고른** 칸입니다.
   */
  level: number | typeof UNKNOWN_LEVEL | null;
}

/**
 * 주소에 실린 선택을 읽는다 (?machineId=3&level=17 · 모드가 있는 게임이면 &mode=S ·
 * 버전이 있는 게임이면 &versionId=1).
 *
 * useSearchParams 가 아니라 window.location 을 직접 읽습니다 — 그쪽을 쓰면 이
 * 페이지가 Suspense 경계를 요구해서, 얻는 것 없이 트리가 하나 더 생깁니다.
 *
 * 값이 이상하면(정수가 아니면) null 로 둡니다. null 은 "서버가 알아서 고르라"는
 * 뜻이라, 주소를 손으로 고쳐 넣어도 화면이 깨지지 않고 기본 조합으로 갑니다.
 */
function selectionFromUrl(): Selection {
  // 서버 렌더에는 주소가 없다. 이때 값이 갈리지만 첫 렌더 출력('불러오는 중…')은
  // sel 과 무관해서 하이드레이션이 어긋나지 않는다.
  if (typeof window === 'undefined') {
    return { machineId: null, versionId: null, mode: null, level: null };
  }

  const q = new URLSearchParams(window.location.search);
  const int = (key: string): number | null => {
    const raw = q.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  };
  return {
    machineId: int('machineId'),
    versionId: int('versionId'),
    mode: q.get('mode'),
    level: q.get('level') === UNKNOWN_LEVEL ? UNKNOWN_LEVEL : int('level'),
  };
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

export default function TierBoardView() {
  const playerId = usePlayerId();

  const [sel, setSel] = useState<Selection>(selectionFromUrl);
  const [games, setGames] = useState<TierGame[]>([]);
  const [levels, setLevels] = useState<LevelOption[]>([]);
  const [board, setBoard] = useState<TierBoard | null>(null);
  const [loading, setLoading] = useState(true);
  /** 서열표를 못 받았을 때의 문구. 예전엔 500 응답의 undefined 가 `.map` 에서 터져 흰 화면이었다 */
  const [loadError, setLoadError] = useState<string | null>(null);

  const [detail, setDetail] = useState<ChartDetail | null>(null);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sel.machineId !== null) params.set('machineId', String(sel.machineId));
      if (sel.versionId !== null) params.set('versionId', String(sel.versionId));
      if (sel.mode !== null) params.set('mode', sel.mode);
      if (sel.level !== null) params.set('level', String(sel.level));

      const res = await fetch(`/api/tier?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `서열표를 불러오지 못했습니다 (${res.status})`);
      setGames((data.games as TierGame[]) ?? []);
      setLevels((data.levels as LevelOption[]) ?? []);
      setBoard((data.board as TierBoard) ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '서열표를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
    // playerId 는 요청에 쓰이지 않지만 **의존성에는 남깁니다**. 내 클리어·투표
    // 표시는 서버가 세션에서 읽으므로, 로그인한 사람이 바뀌면 같은 주소라도
    // 응답이 달라집니다 — 빼면 앞사람의 표시가 그대로 남습니다.
  }, [sel, playerId]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  /**
   * 그려진 조합을 주소에 남긴다 — 새로고침하면 보던 서열표가 그대로 나온다.
   *
   * 요청값(sel)이 아니라 **board** 를 씁니다. sel 은 게임만 고르고 모드·레벨은
   * 비워 두는 경우가 있어(그 게임의 첫 조합을 서버가 고른다), sel 을 주소에
   * 적으면 새로고침했을 때 레벨이 빠진 주소가 되어 다시 첫 조합으로 갑니다.
   * board 는 서버가 실제로 고른 결과라 그 자리를 정확히 가리킵니다.
   *
   * pushState 가 아니라 replaceState 입니다 — 레벨을 훑어보는 동안 히스토리가
   * 쌓이면 뒤로가기를 여러 번 눌러야 이 페이지를 벗어나게 됩니다.
   */
  useEffect(() => {
    if (!board) return;

    const q = new URLSearchParams();
    q.set('machineId', String(board.game.machineId));
    // 버전을 구분하지 않는 게임(펌프·사볼)은 빈 versionId= 를 남기지 않는다.
    if (board.versionId !== null) q.set('versionId', String(board.versionId));
    // 난이도 축인 게임(사볼)은 모드가 없다 — 빈 mode= 를 남기지 않는다.
    if (board.mode !== null) q.set('mode', board.mode);
    q.set('level', board.level === null ? UNKNOWN_LEVEL : String(board.level));

    const next = `${window.location.pathname}?${q}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [board]);

  // 로그인한 사람이 바뀌면 열려 있는 상세도 그 사람 기준으로 다시 읽는다.
  // (playerId 를 보내지는 않는다 — 서버가 세션에서 읽는다. 다시 읽는 것 자체가
  //  필요한 이유는 내 클리어·투표 표시가 그 사람 기준이기 때문이다.)
  useEffect(() => {
    if (!detail) return;
    fetch(`/api/charts/${detail.id}`)
      .then((r) => r.json())
      .then((d) => d.chart && setDetail(d.chart as ChartDetail))
      .catch(() => undefined);
    // detail.id 가 아니라 playerId 변경에만 반응해야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerId]);

  const openChart = async (id: number) => {
    try {
      const res = await fetch(`/api/charts/${id}`);
      const data = await res.json();
      if (res.ok && data.chart) setDetail(data.chart as ChartDetail);
    } catch {
      // 상세를 못 열었을 뿐 — 서열표는 그대로 보인다
    }
  };

  const handleChanged = (chart: ChartDetail) => {
    setDetail(chart);
    void loadBoard(); // 등급이 바뀌었을 수 있으므로 서열표를 다시 계산해 받는다
  };

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
    : '서열표';

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
                해당 서열표는 {board.settings.chartBasis}를 기준으로 작성되었습니다.
              </p>
            )}
            <p className="muted small">
              같은 레벨 안에서의 체감 난이도를, 그 채보를 <strong>클리어한 사람들의</strong>{' '}
              투표 평균으로 배치합니다. 채보를 누르면 평가(코멘트)도 볼 수 있습니다.
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
                setSel({
                  machineId: Number(e.target.value),
                  versionId: null,
                  mode: null,
                  level: null,
                })
              }
              title="서열표가 등록된 게임"
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
                  setSel((s) => ({
                    machineId: s.machineId,
                    versionId: Number(e.target.value),
                    mode: null,
                    level: null,
                  }))
                }
                title="채보 목록의 기준 버전"
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
                  setSel((s) => ({
                    machineId: s.machineId,
                    versionId: s.versionId,
                    mode: e.target.value,
                    level: null,
                  }))
                }
                title="플레이 모드"
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
                setSel((s) => ({
                  machineId: s.machineId,
                  versionId: s.versionId,
                  mode: modeIsDifficulty ? null : activeMode,
                  level:
                    e.target.value === UNKNOWN_LEVEL ? UNKNOWN_LEVEL : Number(e.target.value),
                }))
              }
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
        </header>

        {loadError ? (
          <p className="warn pad" role="alert">
            {loadError}{' '}
            <button type="button" className="btn btn-sm" onClick={() => void loadBoard()}>
              다시 시도
            </button>
          </p>
        ) : loading && !board ? (
          <p className="muted pad">불러오는 중…</p>
        ) : !board ? (
          <p className="muted pad">이 게임에는 아직 등록된 채보가 없습니다.</p>
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
                      className={`chart-chip ${detail?.id === c.id ? 'is-on' : ''}`}
                      onClick={() => openChart(c.id)}
                      title={[
                        `${c.voteCount}표`,
                        c.myVote !== null ? `내 투표 ${c.myVote.toFixed(1)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    >
                      {c.myClear && <i className="clear-mark" title="클리어함" />}
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
                아직 투표가 모이지 않아 등급에 놓인 채보가 없습니다.
                {undecidedCount > 0 && ` 이 구간의 ${undecidedCount}곡은 모두 위 ‘미정’ 에 있습니다.`}{' '}
                클리어한 채보를 눌러 체감 난이도를 투표하면 등급 칸에 줄이 섭니다.
              </p>
            )}
            {[board.game.name, board.versionLabel, modeLevelLabel(board.mode, board.level)]
              .filter(Boolean)
              .join(' ')}{' '}
            · 총 {board.totalCharts}곡 · 투표{' '}
            {board.settings.minVotes}건 미만은 &lsquo;미정&rsquo;, 수렴도{' '}
            {board.settings.minConvergence} 미만은 &lsquo;개인차&rsquo;로 분류됩니다. 투표 범위{' '}
            {board.settings.voteMin.toFixed(1)} ~ {board.settings.voteMax.toFixed(1)}. 등급 단계와 임계값은 게임마다
            다릅니다.
          </footer>
        )}
      </section>

      <aside className="tier-side">
        {detail ? (
          <ChartDetailPanel
            chart={detail}
            playerId={playerId}
            onChanged={handleChanged}
            onClose={() => setDetail(null)}
          />
        ) : (
          <div className="detail-empty muted">
            <p>채보를 선택하면 투표 분포 · 내 기록 · 채보 평가를 볼 수 있습니다.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
