import type { ChartComment } from './community-types';

/**
 * 등급이 아니라 "상태"인 분류들.
 *
 * unique · undecided 는 투표 집계(recalc_chart_stats)가 tier_code 에 써 주고,
 * special 은 표시 인원으로 **읽을 때** 판정합니다 — isSpecialChart().
 */
export const UNIQUE_CODE = 'unique';
export const UNDECIDED_CODE = 'undecided';
export const SPECIAL_CODE = 'special';

/**
 * 레벨이 알려지지 않은 채보들이 모이는 칸.
 *
 * `charts.level` 이 NULL 인 채보입니다 — **채보는 있는데 출처가 난이도를 모르는**
 * 경우로, 빼지도 지어내지도 않고 자기 칸에 모읍니다 (migrate-059 의 `?` 셋).
 * 화면에는 `?` 로 보이고, 주소·API 에서는 이 문자열이 그 칸을 가리킵니다
 * (`?level=unknown`) — 숫자 자리에 물음표를 넣으면 파서가 흔들립니다.
 */
export const UNKNOWN_LEVEL = 'unknown';

/**
 * 특수 패턴 칸으로 갈 조건. 한 사람이 켜면 모두에게 보이는 것을 막으려고
 * 인원 합의(기본 3명)를 둡니다 — 투표의 min_votes 와 같은 성격이지만 값은 따로입니다.
 *
 * **서버(서열표 묶기)와 화면(현재 등급 표시)이 이 함수를 같이 씁니다.** 규칙을
 * 두 벌로 두면 서열표에 놓인 칸과 패널이 보여주는 등급이 어긋납니다.
 */
export function isSpecialChart(
  chart: { specialCount: number },
  settings: { specialMin: number },
): boolean {
  return chart.specialCount >= settings.specialMin;
}

/** 서열표에서 이 채보가 놓이는 칸의 코드 */
export function tierCodeOf(
  chart: { specialCount: number; tierCode: string | null },
  settings: { specialMin: number },
): string {
  if (isSpecialChart(chart, settings)) return SPECIAL_CODE;
  return chart.tierCode ?? UNDECIDED_CODE;
}

/** 게임별 플레이 모드 (펌프 S/D/CO, 사볼 NOV/ADV/EXH/MXM …) */
export interface GameMode {
  code: string;
  label: string;
}

/**
 * 기종 하나 안의 버전 (EZ2DJ 6th TRAX …). 오래된 순.
 *
 * **버전을 구분하지 않는 게임은 빈 배열**이고, 그러면 화면도 선택기를 그리지
 * 않습니다 — 모드 축이 난이도인 게임에 모드 버튼이 없는 것과 같은 방식입니다.
 * 같은 곡이라도 버전마다 채보가 달라, 섞으면 서열표가 뜻을 잃기 때문에 채보가
 * 버전을 답니다 (migrate-059).
 */
export interface GameVersion {
  id: number;
  code: string;
  label: string;
}

/**
 * 한 모드 안에서 곡마다 갈리는 채보 (EZ2DJ 의 N · H). 쉬운 순.
 *
 * 모드와 다른 축입니다 — 모드는 **무엇을 플레이하는가**(Ruby·Club·Space…)고,
 * 난이도는 **같은 곡의 어느 채보인가**입니다. 그래서 보드는 (모드, 레벨)로 정해지고
 * 난이도는 사볼처럼 곡명 뒤 대괄호로만 표시됩니다 — 같은 레벨이면 N 이든 H 든
 * 한 표에서 비교해야 하기 때문입니다 (migrate-059, 근거는 migrate-045).
 *
 * 난이도 축이 없는 게임(펌프)은 빈 배열이고 `ChartSummary.difficulty` 는 null 입니다.
 * 사볼은 예외적으로 **모드 축이 아예 없어** 난이도를 `mode` 에 담고
 * `modeIsDifficulty` 로 구분합니다.
 */
export interface GameDifficulty {
  code: string;
  label: string;
}

/** 서열표를 가진 게임 = tier_settings 가 등록된 기종 */
export interface TierGame {
  machineId: number;
  name: string;
  shortName: string;
  modes: GameMode[];
  /** 버전을 구분하지 않는 게임(펌프·사볼)은 빈 배열 */
  versions: GameVersion[];
  /** 난이도 축이 없는 게임(펌프·사볼)은 빈 배열 */
  difficulties: GameDifficulty[];
  chartCount: number;
}

/** 등급 구간표 1행 */
export interface TierGrade {
  code: string;
  label: string;
  anchor: number;
  sortOrder: number;
}

/** 게임별 집계 임계값 */
export interface TierSettings {
  machineId: number;
  voteMin: number;
  voteMax: number;
  /** 투표 슬라이더 눈금 간격 (화면 입력 단위 — 집계에는 쓰이지 않는다) */
  voteStep: number;
  tierStep: number;
  minVotes: number;
  minConvergence: number;
  /** 이 수 이상이 표시하면 '특수패턴' 칸으로 간다 */
  specialMin: number;
  /**
   * 채보 목록을 어느 버전 기준으로 모았는지 (펌프 = 'PHOENIX 2').
   *
   * null 이면 화면이 그 줄을 그리지 않습니다 — 게임마다 기준이 다르고, 아직
   * 정해지지 않은 게임도 있어서 문구를 하드코딩하지 않습니다 (migrate-044).
   */
  chartBasis: string | null;
  /**
   * machine_modes 가 모드가 아니라 **난이도**인가 (사볼 = true, 펌프 = false).
   *
   * true 면 보드가 레벨만으로 정해지고(EXH18 과 MXM18 이 한 표에 섞임) 난이도는
   * 곡명 뒤 대괄호로 표시합니다. 펌프의 Single/Double 은 발판 쓰는 방식이 달라
   * 비교 대상이 아니므로 false 로 두고 지금까지처럼 모드별 보드를 유지합니다.
   * 근거는 migrate-045.
   */
  modeIsDifficulty: boolean;
}

/** 레벨 선택기 한 항목. mode 가 null 이면 레벨만으로 보드가 정해지는 게임이다. */
export interface TierLevelOption {
  mode: string | null;
  /** null = 난이도 미상 채보들의 칸 (화면에 `?`) — [[UNKNOWN_LEVEL]] 참고 */
  level: number | null;
  chartCount: number;
}

export interface ChartSummary {
  id: number;
  title: string;
  artist: string | null;
  /**
   * machine_modes.code. 게임마다 값이 달라 유니온으로 고정하지 않는다.
   * null = 난이도 미표기 — 출처 표에 난이도가 없던 채보다 (migrate-047).
   */
  mode: string | null;
  /**
   * machine_difficulties.code. 난이도 축이 있는 게임(EZ2DJ)에서만 값이 있고,
   * 없는 게임은 null 입니다 — 칩의 대괄호도 그때만 그려집니다 (migrate-059).
   */
  difficulty: string | null;
  /** null = 난이도 미상 (UNKNOWN_LEVEL) */
  level: number | null;
  voteCount: number;
  /** 투표가 없으면 null */
  avgVote: number | null;
  /** 투표 2건 미만이면 null */
  convergence: number | null;
  /** tier_grades.code | 'unique' | 'undecided' */
  tierCode: string | null;
  /**
   * 이 채보를 특수 패턴으로 표시한 사람 수. settings.specialMin 이상이면
   * 등급과 상관없이 '특수패턴' 칸에 놓인다 — 판정은 isSpecialChart().
   * tierCode 는 그대로 남으므로 임계값 아래로 내려가면 원래 등급으로 돌아간다.
   */
  specialCount: number;
  /** 현재 플레이어 기준 */
  myClear: boolean;
  myVote: number | null;
  /** 내가 특수 패턴으로 표시했는지 */
  mySpecial: boolean;
}

/** 등급 하나와 거기 속한 채보들 */
export interface TierGroup {
  code: string;
  label: string;
  anchor: number | null;
  charts: ChartSummary[];
}

export interface TierBoard {
  settings: TierSettings;
  game: TierGame;
  /**
   * 이 보드가 어느 버전의 것인가. 버전을 구분하지 않는 게임은 **null** 이고,
   * 그때는 그 기종의 채보 전부가 한 보드에 실립니다 (migrate-059).
   */
  versionId: number | null;
  versionLabel: string | null;
  /**
   * 이 보드가 어느 모드의 것인가. `settings.modeIsDifficulty` 인 게임에서는
   * 레벨만으로 보드가 정해지므로 **null** 입니다 (여러 난이도가 함께 실립니다).
   */
  mode: string | null;
  modeLabel: string | null;
  /** null = 난이도 미상 채보들의 보드 (UNKNOWN_LEVEL) */
  level: number | null;
  /** 최상 → 최하 순, 마지막에 개인차 / 특수패턴 / 미정 */
  groups: TierGroup[];
  totalCharts: number;
}

export interface ChartDetail extends ChartSummary {
  /** 익명화된 투표값 전체 (분포 히스토그램용) */
  votes: number[];
  grades: TierGrade[];
  settings: TierSettings;
  /** 이 채보가 속한 게임 — 게임마다 등급 단계 수와 투표 범위가 다르다 */
  machineId: number;
  machineName: string;
  /** null = 난이도 미표기 (ChartSummary.mode 참고) */
  modeLabel: string | null;
  /** null = 이 게임·버전에 난이도 축이 없다 (ChartSummary.difficulty 참고) */
  difficultyLabel: string | null;
  /** 채보 평가 (코멘트 + 성향 태그) */
  comments: ChartComment[];
  /**
   * 대표 플레이 영상(유튜브). 없으면 null (db/migrate-065-chart-video.sql).
   *
   * 목록(ChartSummary)에는 넣지 않습니다 — 한 보드에 채보가 수백 개인데 그 중
   * 상세를 여는 것은 한 번에 하나입니다.
   */
  videoUrl: string | null;
}

/**
 * DB 에 담긴 주소를 **링크로 그려도 되는 것만** 돌려줍니다. 아니면 null.
 *
 * 값을 넣는 곳이 마이그레이션·관리자뿐이어도 화면에서 한 번 더 봅니다 —
 * href 에 그대로 꽂는 값이라, 잘못 들어온 `javascript:` 한 줄이 곧 실행입니다.
 * 받는 것은 https 인 youtube.com · youtu.be 뿐입니다(이 칸의 용도가 그것뿐).
 */
export function youtubeWatchUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  const ok = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  return ok ? url.toString() : null;
}

/**
 * 영상이 **등록되지 않은** 채보의 유튜브 검색 주소.
 *
 * 채보 하나하나에 영상을 손으로 달아 두는 것은 규모가 허락하지 않습니다 —
 * 서열표에 담긴 채보가 20,267개(펌프만 4,466개)입니다. 대신 그 채보를 가리키는
 * 검색어를 **채보 자신의 값으로** 만들어, 등록된 영상이 없어도 한 번 눌러
 * 찾아볼 수 있게 합니다.
 *
 * 검색어는 커뮤니티가 실제로 쓰는 표기를 따릅니다 — 펌프는 'Beethoven Virus S4'
 * 처럼 모드 글자와 레벨을 붙여 씁니다. 게임 이름과 '채보' 를 덧붙여 같은 제목의
 * 다른 게임 영상과 노래 영상이 덜 섞이게 합니다.
 */
export function chartVideoSearchUrl(chart: {
  title: string;
  mode: string | null;
  level: number | null;
  machineName: string;
}): string {
  const step =
    chart.mode === null
      ? chart.level === null
        ? ''
        : `Lv.${chart.level}`
      : `${chart.mode}${chart.level ?? ''}`;
  const query = [chart.title, step, chart.machineName, '채보'].filter(Boolean).join(' ');
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

export interface Player {
  id: number;
  nickname: string;
}
