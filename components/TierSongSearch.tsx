'use client';

import { useEffect, useId, useState } from 'react';
import {
  CHART_SEARCH_SONG_LIMIT,
  chartStepLabel,
  normalizeChartQuery,
} from '@/lib/chart-search-types';
import type { ChartSearchChart, ChartSearchSong } from '@/lib/chart-search-types';
import type { TierGame } from '@/lib/tier-types';

interface Props {
  game: TierGame;
  /** 버전을 구분하는 게임(EZ2DJ)은 지금 보는 버전 안에서만 찾는다 */
  versionId: number | null;
  /** 채보를 고르면 — 서열표가 그 레벨로 건너가 패널을 연다 */
  onPick: (chart: ChartSearchChart) => void;
}

type Result =
  | { state: 'idle' }
  | { state: 'loading'; q: string }
  | { state: 'done'; q: string; songs: ChartSearchSong[] }
  | { state: 'error'; q: string; message: string };

/**
 * 서열표 곡 검색 (UX 시험 2026-11-20 T-1).
 *
 * 서열표는 레벨 한 칸씩만 보여 줘서, 레벨을 모르면 곡을 찾을 길이 없었습니다. 이 칸은 그
 * 게임의 **모든 레벨**에서 곡 이름을 찾고, 곡마다 채보(`Single Lv.20` · `Double Lv.21` …)를
 * 단추로 보여 줍니다. 단추를 누르면 그 레벨로 건너가 채보 패널이 열립니다.
 *
 * 적는 동안 0.25초 쉬면 찾습니다 — 찾기 단추를 따로 두지 않아 이 화면의 주 버튼(투표)과
 * 겹치지 않습니다 (DESIGN-GUIDE §1-2). Esc 는 검색어를 비웁니다.
 */
export default function TierSongSearch({ game, versionId, onPick }: Props) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const listId = useId();
  const q = normalizeChartQuery(text);

  useEffect(() => {
    if (q === null) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setResult({ state: 'loading', q });
      try {
        const params = new URLSearchParams({
          machineId: String(game.machineId),
          q,
        });
        if (versionId !== null) params.set('versionId', String(versionId));
        const res = await fetch(`/api/charts/search?${params}`, {
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setResult({
            state: 'error',
            q,
            message: data.error ?? '곡을 찾지 못했어요. 다시 시도해 주세요',
          });
          return;
        }
        setResult({
          state: 'done',
          q,
          songs: (data.songs as ChartSearchSong[]) ?? [],
        });
      } catch {
        if (ctrl.signal.aborted) return;
        setResult({
          state: 'error',
          q,
          message: '연결이 잠깐 끊겼어요. 다시 시도해 주세요',
        });
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [q, game.machineId, versionId]);

  // 검색어를 지우면 결과도 걷는다 (앞 검색의 결과가 남아 있지 않게)
  const shown: Result = q === null ? { state: 'idle' } : result;

  const pick = (c: ChartSearchChart) => {
    setText('');
    setResult({ state: 'idle' });
    onPick(c);
  };

  return (
    <div className="tier-search" role="search">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text !== '') {
            e.preventDefault();
            setText('');
          }
        }}
        placeholder={`${game.shortName || game.name} 곡 이름으로 찾기 (모든 레벨)`}
        aria-label={`${game.name} 곡 이름으로 찾기`}
        aria-controls={listId}
        maxLength={60}
        autoComplete="off"
        enterKeyHint="search"
      />

      <div id={listId} className="tier-search-results" hidden={shown.state === 'idle'}>
        <p className="muted small" role="status">
          {shown.state === 'loading' && '찾는 중…'}
          {shown.state === 'done' &&
            (shown.songs.length === 0
              ? `‘${shown.q}’에 맞는 곡이 ${game.name}에 없어요. 이름 일부만 적어 보세요`
              : shown.songs.length >= CHART_SEARCH_SONG_LIMIT
                ? `${shown.songs.length}곡을 먼저 보여 드려요. 이름을 더 적으면 좁혀져요`
                : `${shown.songs.length}곡을 찾았어요. 채보를 누르면 그 레벨로 가요`)}
        </p>
        {shown.state === 'error' && (
          <p className="warn small" role="alert">
            {shown.message}
          </p>
        )}
        {shown.state === 'done' && shown.songs.length > 0 && (
          <ul className="tier-search-list">
            {shown.songs.map((s) => (
              <li key={s.songId}>
                <div className="tier-search-song">
                  <strong>{s.title}</strong>
                  {s.artist && <span className="muted small"> · {s.artist}</span>}
                </div>
                <div className="tier-search-charts">
                  {s.charts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => pick(c)}
                      aria-label={`${s.title} ${chartStepLabel(c, game)} 열기`}
                    >
                      {chartStepLabel(c, game)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
