import type { TierGame } from './tier-types';

/**
 * 서열표 곡 검색의 모양과 순수 함수 — 화면(components)과 서버(lib/chart-search.ts)가 같이
 * 씁니다. 이 파일은 DB 를 물지 않습니다 (tests/architecture.test.ts).
 */

/** 곡 결과 상한 (GUIDELINES §4-4). 화면 목록이 이 이상이면 검색어를 더 쓰는 편이 빠릅니다. */
export const CHART_SEARCH_SONG_LIMIT = 20;
/**
 * 곡 하나에 실을 채보 상한. 한 버전 안에서 곡 하나의 채보는 가장 많아야 17개입니다
 * (EZ2DJ · 2026-11-21 실측). 버전을 구분하는 게임은 늘 한 버전으로 좁혀 부르므로 넉넉합니다.
 */
export const CHART_SEARCH_CHART_LIMIT = 40;
/** 검색어 최대 길이 — 그보다 긴 곡 이름은 앞부분으로도 충분히 좁혀집니다 */
export const CHART_SEARCH_MAX_QUERY = 50;

export interface ChartSearchChart {
  id: number;
  /** machine_modes.code. null = 난이도 미표기 */
  mode: string | null;
  /** machine_difficulties.code. 난이도 축이 없는 게임은 null */
  difficulty: string | null;
  /** null = 난이도 미상 */
  level: number | null;
  /** 버전을 구분하지 않는 게임은 null */
  versionId: number | null;
}

export interface ChartSearchSong {
  songId: number;
  title: string;
  artist: string | null;
  charts: ChartSearchChart[];
}

/** GET /api/charts/:id/siblings 응답 */
export interface SongCharts {
  songId: number;
  title: string;
  charts: ChartSearchChart[];
}

/**
 * 검색어를 다듬는다 — 앞뒤 공백을 걷고, 가운데 공백은 하나로, 길이는 상한까지.
 * 남는 것이 없으면 null (검색하지 않는다).
 */
export function normalizeChartQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.replace(/\s+/g, ' ').trim().slice(0, CHART_SEARCH_MAX_QUERY).trim();
  return q === '' ? null : q;
}

/**
 * 곡 하나의 채보를 게임의 순서대로 세운다 — 모드(machine_modes.sort_order) → 난이도
 * (machine_difficulties.sort_order) → 레벨(미상은 끝) → id.
 *
 * 코드의 알파벳순이면 펌프는 D 가 S 보다, 사볼은 ADV 가 NOV 보다 앞에 옵니다. 게임이 정한
 * 순서가 있으니 그것을 따르고, 등록되지 않은 코드는 뒤로 밀되 빼지 않습니다
 * (lib/tier.ts listLevels 와 같은 규칙). 마지막 id 는 같은 값끼리 순서를 고정합니다.
 */
export function sortSongCharts(
  charts: ChartSearchChart[],
  game: Pick<TierGame, 'modes' | 'difficulties'>,
): ChartSearchChart[] {
  const modeRank = new Map(game.modes.map((m, i) => [m.code, i]));
  const diffRank = new Map(game.difficulties.map((d, i) => [d.code, i]));
  const rank = (map: Map<string, number>, code: string | null) =>
    code !== null && map.has(code) ? map.get(code)! : Number.MAX_SAFE_INTEGER;
  const lvl = (l: number | null) => (l === null ? Number.POSITIVE_INFINITY : l);

  return [...charts].sort(
    (a, b) =>
      rank(modeRank, a.mode) - rank(modeRank, b.mode) ||
      (a.mode ?? '').localeCompare(b.mode ?? '') ||
      rank(diffRank, a.difficulty) - rank(diffRank, b.difficulty) ||
      (a.difficulty ?? '').localeCompare(b.difficulty ?? '') ||
      (lvl(a.level) === lvl(b.level) ? 0 : lvl(a.level) < lvl(b.level) ? -1 : 1) ||
      a.id - b.id,
  );
}

/**
 * 채보 하나를 사람이 읽는 짧은 말로 — `Single Lv.20` · `MAXIMUM Lv.18` · `7 Street HD Lv.12`.
 *
 * 모드는 게임이 부르는 표기를 쓰고(서열표 제목과 같은 규칙), 게임을 모르면 코드를 그대로
 * 씁니다. 난이도(EZ2DJ 의 HD 등)는 칩의 대괄호처럼 코드로 둡니다. 레벨을 모르면 `Lv.?`.
 */
export function chartStepLabel(
  c: Pick<ChartSearchChart, 'mode' | 'difficulty' | 'level'>,
  game?: Pick<TierGame, 'modes'> | null,
): string {
  const mode =
    c.mode === null ? null : (game?.modes.find((m) => m.code === c.mode)?.label ?? c.mode);
  return [mode, c.difficulty, `Lv.${c.level ?? '?'}`].filter(Boolean).join(' ');
}
