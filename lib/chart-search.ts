import { getPrismaClient, num } from './prisma';
import { listGames } from './tier';
import type { TierGame } from './tier-types';
import {
  CHART_SEARCH_CHART_LIMIT,
  CHART_SEARCH_SONG_LIMIT,
  sortSongCharts,
} from './chart-search-types';
import type { ChartSearchChart, ChartSearchSong, SongCharts } from './chart-search-types';

export { normalizeChartQuery } from './chart-search-types';

/**
 * 서열표 곡 검색 · 같은 곡의 다른 채보 (UX 시험 2026-11-20 T-1).
 *
 * 서열표는 (게임, 모드, 레벨) 한 칸씩만 보여 줘서, 곡의 레벨을 모르면 그 곡을 찾을 길이
 * 없었습니다 — 칩 130개를 눈으로 훑거나 브라우저 Ctrl+F 가 전부였습니다. 여기서는 그 게임의
 * **모든 레벨**을 대상으로 곡 이름을 찾고, 결과마다 그 곡의 채보(모드 · 난이도 · 레벨)를 함께
 * 돌려줘서 화면이 바로 그 칸으로 건너가게 합니다.
 *
 * 왜 TypedSQL 이 아니라 Prisma 질의인가: 필터가 "게임 + 제목 포함" 하나라 정렬 규칙이 없고,
 * songs 는 게임마다 수백~천여 줄이라 `songs_machine_id_title_key` 로 게임을 좁힌 뒤 ILIKE 를
 * 걸어도 0.4ms 입니다 (2026-11-21 EXPLAIN ANALYZE · 펌프 833줄 · 버퍼 28). 따로 색인을 둘
 * 크기가 아닙니다 (GUIDELINES §1-1).
 */

/**
 * 버전을 구분하는 게임(EZ2DJ)은 반드시 한 버전으로 좁힌다 — 같은 곡이 버전마다 채보를 따로
 * 가져서(최대 83개) 섞으면 결과가 읽히지 않고, 서열표도 버전 하나씩 보여 줍니다.
 * 모르는 버전이 오면 서열표 API 처럼 첫 버전으로 갑니다 (app/api/tier/route.ts).
 */
function resolveVersion(game: TierGame, versionId: number | null): number | null {
  if (game.versions.length === 0) return null;
  return game.versions.some((v) => v.id === versionId) ? versionId : game.versions[0].id;
}

const chartSelect = {
  id: true,
  mode: true,
  difficulty: true,
  level: true,
  version_id: true,
} as const;

function toChart(c: {
  id: number;
  mode: string | null;
  difficulty: string | null;
  level: unknown;
  version_id: number | null;
}): ChartSearchChart {
  return {
    id: c.id,
    mode: c.mode,
    difficulty: c.difficulty,
    level: num(c.level),
    versionId: c.version_id,
  };
}

/**
 * 게임 하나 안에서 곡 이름으로 찾는다. 서열표가 없는 게임이면 빈 목록.
 *
 * 순서: **이름이 검색어로 시작하는 곡** → 이름 안에 검색어가 든 곡, 각각 제목 → id 순.
 * 'night' 를 치면 'Night Duty' 가 'Midnight …' 보다 먼저 와야 합니다. 한 질의로 하면
 * 앞엣것이 상한에 잘려 나갈 수 있어 두 번에 나눠 묻습니다 (둘 다 상한 안).
 */
export async function searchChartSongs(params: {
  machineId: number;
  versionId: number | null;
  q: string;
}): Promise<ChartSearchSong[]> {
  const games = await listGames();
  const game = games.find((g) => g.machineId === params.machineId);
  if (!game) return [];

  const versionId = resolveVersion(game, params.versionId);
  const chartsWhere = versionId === null ? {} : { version_id: versionId };
  const select = {
    id: true,
    title: true,
    artist: true,
    charts: {
      where: chartsWhere,
      select: chartSelect,
      orderBy: { id: 'asc' as const },
      take: CHART_SEARCH_CHART_LIMIT,
    },
  };
  const base = { machine_id: game.machineId, charts: { some: chartsWhere } };
  const orderBy = [{ title: 'asc' as const }, { id: 'asc' as const }];

  const prisma = await getPrismaClient();
  const head = await prisma.songs.findMany({
    where: { ...base, title: { startsWith: params.q, mode: 'insensitive' } },
    orderBy,
    take: CHART_SEARCH_SONG_LIMIT,
    select,
  });
  const room = CHART_SEARCH_SONG_LIMIT - head.length;
  const tail =
    room > 0
      ? await prisma.songs.findMany({
          where: {
            ...base,
            title: { contains: params.q, mode: 'insensitive' },
            NOT: { title: { startsWith: params.q, mode: 'insensitive' } },
          },
          orderBy,
          take: room,
          select,
        })
      : [];

  return [...head, ...tail].map((s) => ({
    songId: s.id,
    title: s.title,
    artist: s.artist ?? null,
    charts: sortSongCharts(s.charts.map(toChart), game),
  }));
}

/**
 * 이 채보와 같은 곡의 채보 전부 (자기 자신 포함 · 게임 순서대로). 채보가 없으면 null.
 *
 * 버전을 구분하는 게임은 **같은 버전 안에서만** 찾습니다 — 서열표가 버전 하나씩이라,
 * 다른 버전의 같은 곡은 다른 표의 다른 채보입니다.
 */
export async function listSongCharts(chartId: number): Promise<SongCharts | null> {
  const prisma = await getPrismaClient();
  const chart = await prisma.charts.findUnique({
    where: { id: chartId },
    select: {
      version_id: true,
      songs: { select: { id: true, title: true, machine_id: true } },
    },
  });
  if (!chart) return null;

  const rows = await prisma.charts.findMany({
    where: { song_id: chart.songs.id, version_id: chart.version_id },
    select: chartSelect,
    orderBy: { id: 'asc' },
    take: CHART_SEARCH_CHART_LIMIT,
  });
  const game = (await listGames()).find((g) => g.machineId === chart.songs.machine_id);
  const charts = rows.map(toChart);
  return {
    songId: chart.songs.id,
    title: chart.songs.title,
    charts: game ? sortSongCharts(charts, game) : charts,
  };
}
