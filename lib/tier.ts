import { cacheReference } from './cache';
import { listComments } from './comments';
import { recalcChartStats, tierCharts } from './typed-sql';
import { getPrismaClient, num } from './prisma';
import {
  SPECIAL_CODE,
  UNDECIDED_CODE,
  UNIQUE_CODE,
  tierCodeOf,
} from './tier-types';
import type {
  ChartDetail,
  ChartSummary,
  TierBoard,
  TierGame,
  TierGrade,
  TierGroup,
  TierLevelOption,
  TierSettings,
} from './tier-types';

/** 게임을 지정하지 않았을 때의 기본값 (Pump It Up). listGames() 의 첫 항목과 같습니다. */
export const DEFAULT_MACHINE_ID = 1;

// 상태 코드와 특수 패턴 판정 규칙은 lib/tier-types.ts 에 있습니다 —
// 화면(ChartDetailPanel)도 같은 규칙을 써야 하고, 그 파일은 DB 를 물지 않습니다.
export { SPECIAL_CODE, UNDECIDED_CODE, UNIQUE_CODE } from './tier-types';

export async function getSettings(machineId = DEFAULT_MACHINE_ID): Promise<TierSettings> {
  const prisma = await getPrismaClient();
  const r = await prisma.tier_settings.findUnique({ where: { machine_id: machineId } });
  if (!r) throw new Error(`tier_settings 에 machine_id=${machineId} 설정이 없습니다`);
  return {
    machineId,
    voteMin: num(r.vote_min)!,
    voteMax: num(r.vote_max)!,
    voteStep: num(r.vote_step)!,
    tierStep: num(r.tier_step)!,
    minVotes: num(r.min_votes)!,
    minConvergence: num(r.min_convergence)!,
    specialMin: num(r.special_min)!,
    chartBasis: r.chart_basis ?? null,
    modeIsDifficulty: Boolean(r.mode_is_difficulty),
  };
}

export async function getGrades(machineId = DEFAULT_MACHINE_ID): Promise<TierGrade[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.tier_grades.findMany({
    where: { machine_id: machineId },
    orderBy: { sort_order: 'asc' },
    select: { code: true, label: true, anchor: true, sort_order: true },
  });
  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    anchor: num(r.anchor)!,
    sortOrder: r.sort_order,
  }));
}

/**
 * 서열표가 있는 게임 목록.
 *
 * "기종 마스터에 있는 모든 게임"이 아니라 tier_settings 가 등록된 게임만입니다.
 * 등급 구간표와 임계값이 없으면 서열표를 계산할 수 없고, 인형뽑기까지 게임
 * 선택기에 올라오면 고를 수 없는 항목이 대부분이 됩니다.
 */
async function listGamesUncached(): Promise<TierGame[]> {
  const prisma = await getPrismaClient();
  const games = await prisma.machines.findMany({
    where: { tier_settings: { isNot: null } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      short_name: true,
      machine_modes: { orderBy: { sort_order: 'asc' }, select: { code: true, label: true } },
      // 버전을 구분하지 않는 게임은 빈 배열 → 화면이 선택기를 안 그린다.
      game_versions: { orderBy: { sort_order: 'asc' }, select: { id: true, code: true, label: true } },
      // 난이도 축이 없는 게임은 빈 배열 → 칩에 대괄호가 붙지 않는다.
      machine_difficulties: { orderBy: { sort_order: 'asc' }, select: { code: true, label: true } },
    },
  });

  // 채보 수는 songs 를 거쳐야 세어지므로(charts 에 machine_id 가 없다) 게임마다 한 번씩.
  // 게임이 셋뿐이고 결과는 5분 캐시라 왕복 수는 문제가 아니다.
  const chartCounts = await Promise.all(
    games.map((g) => prisma.charts.count({ where: { songs: { machine_id: g.id } } })),
  );

  return games.map((g, i) => ({
    machineId: g.id,
    name: g.name,
    shortName: g.short_name,
    chartCount: chartCounts[i],
    modes: g.machine_modes,
    versions: g.game_versions,
    difficulties: g.machine_difficulties,
  }));
}

/**
 * 서열표를 제공하는 게임 목록.
 *
 * songs·charts 는 적재 스크립트로만 채우는 참조 데이터라 캐시한다 (근거는 lib/cache.ts).
 * getGame() 도 이 함수를 거치므로 서열표 조회 경로 전체가 함께 덕을 본다.
 */
export const listGames = cacheReference(listGamesUncached, 'tier-games');

async function getGame(machineId: number): Promise<TierGame> {
  const games = await listGames();
  const game = games.find((g) => g.machineId === machineId);
  if (!game) throw new Error(`machine_id=${machineId} 에는 서열표 설정이 없습니다`);
  return game;
}

/**
 * 모드 코드 → 표기. machine_modes 에 없는 코드는 그대로 보여준다.
 * mode 가 null 이면 난이도 미표기라 붙일 표기가 없다 (migrate-047).
 */
function modeLabelOf(game: TierGame, mode: string | null): string | null {
  if (mode === null) return null;
  return game.modes.find((m) => m.code === mode)?.label ?? mode;
}

/** 버전 id → 표기. 버전을 구분하지 않는 게임은 null 이 들어온다. */
function versionLabelOf(game: TierGame, versionId: number | null): string | null {
  if (versionId === null) return null;
  return game.versions.find((v) => v.id === versionId)?.label ?? null;
}

/** 난이도 코드 → 표기. 난이도 축이 없는 채보는 null 이 들어온다. */
function difficultyLabelOf(game: TierGame, difficulty: string | null): string | null {
  if (difficulty === null) return null;
  return game.difficulties.find((d) => d.code === difficulty)?.label ?? difficulty;
}

/** 레벨 비교 — 난이도 미상(NULL)은 목록 끝으로 (SQL 의 ASC NULLS LAST 와 같은 규칙) */
function compareLevel(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * 서열표를 만들 수 있는 (모드, 레벨) 조합.
 *
 * `versionId` 가 null 이면 버전으로 좁히지 않는다 — 버전을 구분하지 않는
 * 게임(펌프·사볼)의 채보는 version_id 가 NULL 이라 애초에 좁힐 것이 없다.
 */
async function listLevelsUncached(
  machineId: number,
  versionId: number | null,
): Promise<TierLevelOption[]> {
  const prisma = await getPrismaClient();
  const where = {
    songs: { machine_id: machineId },
    ...(versionId !== null ? { version_id: versionId } : {}),
  };

  // 난이도 축인 게임(사볼)은 레벨만으로 보드가 정해지므로 (모드, 레벨) 로 쪼개지 않는다.
  const { modeIsDifficulty } = await getSettings(machineId);
  if (modeIsDifficulty) {
    const rows = await prisma.charts.groupBy({ by: ['level'], where, _count: { _all: true } });
    return rows
      .map((r) => ({ mode: null, level: num(r.level), chartCount: r._count._all }))
      .sort((a, b) => compareLevel(a.level, b.level));
  }

  // 알파벳순이면 Double 이 Single 보다 앞에 온다. machine_modes.sort_order(= 게임의 modes
  // 배열 순서)로 고정. 등록되지 않은 모드 코드는 뒤로 밀되 목록에서 빼지는 않는다.
  const game = await getGame(machineId);
  const rank = new Map(game.modes.map((m, i) => [m.code, i]));
  const rankOf = (mode: string | null) => (mode !== null && rank.has(mode) ? rank.get(mode)! : Infinity);
  const rows = await prisma.charts.groupBy({ by: ['mode', 'level'], where, _count: { _all: true } });
  return rows
    .map((r) => ({ mode: r.mode as string, level: num(r.level), chartCount: r._count._all }))
    .sort(
      (a, b) =>
        rankOf(a.mode) - rankOf(b.mode) ||
        a.mode.localeCompare(b.mode) ||
        compareLevel(a.level, b.level),
    );
}

const listLevelsCached = cacheReference(listLevelsUncached, 'tier-levels');

/**
 * 그 게임·그 버전에서 서열표를 만들 수 있는 (모드, 레벨) 조합.
 *
 * 기본값을 캐시 바깥에서 채워 넘긴다 — 인자를 그대로 캐시 키에 넣으므로
 * `listLevels()` 와 `listLevels(DEFAULT_MACHINE_ID)` 를 그냥 두면 같은 데이터가
 * 서로 다른 키로 두 벌 쌓인다. `versionId` 도 같은 이유로 항상 채워 넘긴다.
 */
export function listLevels(
  machineId = DEFAULT_MACHINE_ID,
  versionId: number | null = null,
): Promise<TierLevelOption[]> {
  return listLevelsCached(machineId, versionId);
}

/** prisma/sql/tierCharts.sql 의 한 줄 */
type ChartRow = Awaited<ReturnType<typeof fetchCharts>>[number];

/**
 * 채보 줄 조회. 정렬·필터의 근거가 SQL 주석에 있어 TypedSQL 로 둔다
 * (prisma/sql/tierCharts.sql — 표시값 반올림 → 배치 순서 → 제목 → 난이도 순서표 …).
 */
async function fetchCharts(params: {
  playerId: number | null;
  chartId?: number | null;
  machineId?: number | null;
  mode?: string | null;
  level?: number | null;
  /** true 면 레벨 미상(NULL) 채보만 — 미상 보드 */
  levelUnknown?: boolean;
  versionId?: number | null;
}) {
  const prisma = await getPrismaClient();
  return prisma.$queryRawTyped(
    tierCharts(
      params.playerId,
      params.chartId ?? null,
      params.machineId ?? null,
      params.mode ?? null,
      params.level ?? null,
      params.levelUnknown ?? false,
      params.versionId ?? null,
    ),
  );
}

function toSummary(r: ChartRow): ChartSummary {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist ?? null,
    mode: r.mode ?? null,
    difficulty: r.difficulty ?? null,
    level: num(r.level),
    voteCount: r.vote_count,
    avgVote: num(r.avg_vote),
    convergence: num(r.convergence),
    tierCode: r.tier_code ?? null,
    specialCount: r.special_count ?? 0,
    myClear: Boolean(r.my_clear),
    // LEFT JOIN 이라 실제로는 NULL 이 올 수 있다 — 생성된 타입은 non-null 이지만 방어한다.
    myVote: num(r.my_vote as unknown),
    mySpecial: Boolean(r.my_special),
  };
}

export async function getTierBoard(params: {
  machineId?: number;
  /** null = 버전을 구분하지 않는 게임 → 그 기종의 채보를 전부 담는다 */
  versionId?: number | null;
  /** null = 난이도 축인 게임 → 그 레벨의 모든 난이도를 한 보드에 담는다 */
  mode: string | null;
  /** null = 난이도 미상 채보들의 보드 (tier-types UNKNOWN_LEVEL) */
  level: number | null;
  playerId: number | null;
}): Promise<TierBoard> {
  const { machineId = DEFAULT_MACHINE_ID, versionId = null, mode, level, playerId } = params;

  const [settings, grades, game, rows] = await Promise.all([
    getSettings(machineId),
    getGrades(machineId),
    getGame(machineId),
    // 레벨이 NULL 인 채보(난이도 미상)도 자기 보드를 가져야 한다 — level 이 null 이면
    // "미상만" 이라는 뜻이라 levelUnknown 으로 따로 넘긴다 (SQL 주석 참고).
    fetchCharts({ playerId, machineId, mode, level, levelUnknown: level === null, versionId }),
  ]);
  const charts = rows.map(toSummary);

  // 등급별로 묶는다. 빈 등급도 자리를 유지해야 서열 구조가 보인다.
  const byCode = new Map<string, ChartSummary[]>();
  for (const chart of charts) {
    // 특수 패턴이 등급보다 앞선다 — 표시 인원이 임계값을 넘으면 투표와 무관하게 그 칸으로.
    const key = tierCodeOf(chart, settings);
    const bucket = byCode.get(key);
    if (bucket) bucket.push(chart);
    else byCode.set(key, [chart]);
  }

  const groups: TierGroup[] = [
    ...grades.map((g) => ({
      code: g.code,
      label: g.label,
      anchor: g.anchor,
      charts: byCode.get(g.code) ?? [],
    })),
    { code: UNIQUE_CODE, label: '개인차', anchor: null, charts: byCode.get(UNIQUE_CODE) ?? [] },
    {
      code: SPECIAL_CODE,
      label: '특수패턴',
      anchor: null,
      charts: byCode.get(SPECIAL_CODE) ?? [],
    },
    {
      code: UNDECIDED_CODE,
      label: '미정',
      anchor: null,
      charts: byCode.get(UNDECIDED_CODE) ?? [],
    },
  ];

  return {
    settings,
    game,
    versionId,
    versionLabel: versionLabelOf(game, versionId),
    mode,
    // 난이도 축인 게임은 보드가 한 난이도의 것이 아니므로 라벨도 없다.
    modeLabel: mode === null ? null : modeLabelOf(game, mode),
    level,
    groups,
    totalCharts: charts.length,
  };
}

export async function getChartDetail(
  chartId: number,
  playerId: number | null,
): Promise<ChartDetail | null> {
  const prisma = await getPrismaClient();
  // 설정/등급은 게임마다 다르므로 채보에서 machine_id 를 끌어와야 한다.
  // 기본값으로 읽으면 사볼 채보에 펌프의 7단계 등급표가 붙는다.
  const [row] = await fetchCharts({ playerId, chartId });
  if (!row) return null;
  const machineId = row.machine_id;

  // 분포는 익명 — 누가 몇 점 줬는지는 내보내지 않는다.
  const [voteRows, settings, grades, game, comments] = await Promise.all([
    prisma.difficulty_votes.findMany({
      where: { chart_id: chartId },
      orderBy: { value: 'asc' },
      select: { value: true },
    }),
    getSettings(machineId),
    getGrades(machineId),
    getGame(machineId),
    listComments(chartId),
  ]);

  const summary = toSummary(row);
  return {
    ...summary,
    videoUrl: row.video_url ?? null,
    votes: voteRows.map((v) => num(v.value)!),
    grades,
    settings,
    machineId,
    machineName: game.name,
    modeLabel: modeLabelOf(game, summary.mode),
    difficultyLabel: difficultyLabelOf(game, summary.difficulty),
    comments,
  };
}

/**
 * 투표 반영 후 반드시 호출. 캐시 컬럼(avg/convergence/tier_code)을 갱신한다 —
 * 집계 규칙은 DB 함수 recalc_chart_stats 에 있다 (prisma/sql/recalcChartStats.sql).
 */
async function recalc(chartId: number): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.$queryRawTyped(recalcChartStats(chartId));
}

/** 클리어 기록 등록/해제. 해제하면 그 채보의 투표도 함께 사라진다(FK CASCADE). */
export async function setClear(
  playerId: number,
  chartId: number,
  cleared: boolean,
): Promise<void> {
  const prisma = await getPrismaClient();
  if (cleared) {
    await prisma.clear_records.createMany({
      data: [{ player_id: playerId, chart_id: chartId }],
      skipDuplicates: true,
    });
  } else {
    await prisma.clear_records.deleteMany({ where: { player_id: playerId, chart_id: chartId } });
  }
  await recalc(chartId);
}

/**
 * 특수 패턴 표시 켜기/끄기 (사람별).
 *
 * 투표와 달리 값이 없습니다 — "기믹이 있다" 뿐이라 셀 것은 사람 수입니다.
 * 클리어 게이트도 없습니다 (평가란과 같은 이유 — 못 깨도 기믹은 보입니다).
 *
 * 인원 캐시(charts.special_count)를 갱신해야 하므로 recalc 을 부릅니다. 이때
 * tier_code 는 투표대로 다시 계산될 뿐 특수 패턴에 덮이지 않습니다 — 칸을
 * 가르는 것은 읽을 때(tierCodeOf)입니다.
 */
export async function setSpecial(
  playerId: number,
  chartId: number,
  marked: boolean,
): Promise<void> {
  const prisma = await getPrismaClient();
  if (marked) {
    await prisma.special_marks.createMany({
      data: [{ player_id: playerId, chart_id: chartId }],
      skipDuplicates: true,
    });
  } else {
    await prisma.special_marks.deleteMany({ where: { player_id: playerId, chart_id: chartId } });
  }
  await recalc(chartId);
}

export class NotClearedError extends Error {
  constructor() {
    super('이 채보를 클리어한 기록이 있어야 투표할 수 있습니다');
  }
}

/** value 가 null 이면 투표 취소 */
export async function setVote(
  playerId: number,
  chartId: number,
  value: number | null,
): Promise<void> {
  const prisma = await getPrismaClient();

  if (value === null) {
    await prisma.difficulty_votes.deleteMany({ where: { player_id: playerId, chart_id: chartId } });
    await recalc(chartId);
    return;
  }

  // DB 의 복합 FK 가 최종 방어선이지만, 여기서 먼저 막아야 사용자에게
  // 제약 위반 메시지 대신 뜻이 통하는 403 을 돌려줄 수 있다.
  const cleared = await prisma.clear_records.findUnique({
    where: { player_id_chart_id: { player_id: playerId, chart_id: chartId } },
    select: { chart_id: true },
  });
  if (!cleared) throw new NotClearedError();

  await prisma.difficulty_votes.upsert({
    where: { player_id_chart_id: { player_id: playerId, chart_id: chartId } },
    create: { player_id: playerId, chart_id: chartId, value },
    update: { value, updated_at: new Date() },
  });
  await recalc(chartId);
}
