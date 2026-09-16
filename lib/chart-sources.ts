/**
 * 기종별 수록곡·채보 출처.
 *
 * 게임마다 난이도 체계도 공개 방식도 달라서, 각 출처를 **같은 모양**으로
 * 바꿔 주는 어댑터를 여기 모읍니다. 실제 DB 반영은 scripts/import-charts.ts 가 합니다 —
 * 이 파일은 "어디서 무엇을 어떻게 읽어 오는가" 만 압니다.
 *
 * 새 게임을 붙이려면 `SOURCES` 에 어댑터 하나를 더하면 됩니다. 어댑터가 지켜야 할 것은
 * 두 가지뿐입니다.
 *
 *   · 곡 제목은 **출처가 쓰는 그대로** 둔다. 손대면 다음 실행에서 같은 곡을 못 알아본다.
 *   · 난이도는 `parseLevelNotation` 을 통과시킨다 (13+ 같은 표기를 혼자 해석하지 않는다).
 *
 * ⚠ 여기 있는 출처는 전부 **각 게임사·커뮤니티의 것**입니다. 호출 간격을 지키고,
 *   상대 서버가 형식을 바꾸면 조용히 틀리는 게 아니라 **에러로 멈추도록** 짰습니다
 *   (필드가 없으면 던집니다). 조용히 빈 결과를 넣으면 곡이 사라진 것처럼 보입니다.
 */

/** 어댑터가 내놓는 채보 한 줄 — DB 모양이 아니라 '출처가 말한 것' 그대로다 */
export interface SourceChart {
  /** machine_modes.code 로 그대로 들어간다 */
  mode: string;
  /** 게임이 부르는 이름 (`'13+'`) */
  levelLabel: string;
  /** 줄 세우는 값 (`13.5`) */
  level: number;
}

export interface SourceSong {
  title: string;
  artist: string | null;
  charts: SourceChart[];
}

/** 그 게임의 모드 목록 — machine_modes 에 넣을 값 */
export interface SourceMode {
  code: string;
  label: string;
}

export interface ChartSource {
  /** machines.short_name — 이 값으로 machine_id 를 찾는다 */
  machineShortName: string;
  /** 사람이 읽는 출처 설명. 실행 로그와 문서에 그대로 쓴다 */
  origin: string;
  modes: SourceMode[];
  fetch(): Promise<SourceSong[]>;
}

/**
 * 난이도 표기 → (정렬값, 이름).
 *
 * 세 가지 표기를 받습니다.
 *   '12'    → 12    · '12'      정수 (태고·IIDX·DDR·사볼·팝픈…)
 *   '13+'   → 13.5  · '13+'     플러스 (maimai·츄니즘·노스탤지어)
 *   '10.9'  → 10.9  · '10.9'    소수 (jubeat·기타도라)
 *
 * `13+` 를 13.5 로 두는 것은 그 게임이 13.5 라고 말해서가 아니라 **13 과 14 사이에
 * 세우기 위한 정렬 키**입니다. 화면에 보이는 것은 언제나 label 쪽입니다
 * (db/migrate-058-chart-level-notation.sql).
 *
 * 빈 값·'-' 는 그 난이도가 없는 곡입니다 (Re:MASTER 가 없는 곡처럼). null 을
 * 돌려주고 호출부가 건너뜁니다 — 0 으로 넣으면 없는 채보가 1레벨로 생깁니다.
 */
export function parseLevelNotation(raw: unknown): { level: number; label: string } | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  if (label === '' || label === '-') return null;

  const plus = label.endsWith('+');
  const body = plus ? label.slice(0, -1) : label;
  const n = Number(body);
  if (!Number.isFinite(n) || n < 1) return null;

  return { level: plus ? n + 0.5 : n, label };
}

// ─── 세가 (maimai DX · CHUNITHM) ─────────────────────────────
/*
  둘 다 공식 사이트가 전곡 JSON 을 그대로 내놓습니다. 필드 이름이 같은 꼴이라
  (`lev_bas` · `lev_adv` …) 읽는 코드를 공유합니다.

  ⚠ 한 곡이 여러 번 나오는 경우가 있습니다 — maimai 는 같은 제목으로 STANDARD 와
    DX 채보가 따로 실리고, 이벤트용 '宴' 채보도 섞입니다. songs 는 (기종, 제목)이
    UNIQUE 라 그런 항목들은 **한 곡으로 합쳐집니다**. 모드 코드가 다르므로 채보는
    안 겹치지만, 정말 다른 곡인데 제목이 같은 경우는 임포터가 세어서 알려 줍니다.
*/

/** 세가식 난이도 칸 — [JSON 키, 모드 코드, 모드 이름] */
type SegaColumn = readonly [string, string, string];

async function fetchSegaJson(url: string, columns: readonly SegaColumn[]): Promise<SourceSong[]> {
  const res = await fetch(url, { headers: { 'User-Agent': 'arcade-finder/chart-import' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);

  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${url} 이 배열이 아닙니다`);

  const songs: SourceSong[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) continue;

    const charts: SourceChart[] = [];
    for (const [key, mode] of columns) {
      const parsed = parseLevelNotation(row[key]);
      if (parsed) charts.push({ mode, levelLabel: parsed.label, level: parsed.level });
    }
    // 난이도가 하나도 없으면 곡이 아니라 표 머리글 같은 잡행이다.
    if (charts.length === 0) continue;

    songs.push({
      title,
      artist: typeof row.artist === 'string' && row.artist.trim() ? row.artist.trim() : null,
      charts,
    });
  }
  if (songs.length === 0) throw new Error(`${url} 에서 곡을 한 곡도 못 읽었습니다 (형식 변경?)`);
  return songs;
}

/**
 * maimai DX — STANDARD 5 난이도 + DX 5 난이도.
 *
 * 같은 곡에 두 벌이 실리므로 모드 코드를 갈라 둡니다 (`EXP` vs `DX_EXP`).
 * 갈라두지 않으면 (곡, 모드, 층) UNIQUE 에 걸려 한쪽이 버려집니다.
 */
const MAIMAI_COLUMNS: readonly SegaColumn[] = [
  ['lev_bas', 'BAS', 'BASIC'],
  ['lev_adv', 'ADV', 'ADVANCED'],
  ['lev_exp', 'EXP', 'EXPERT'],
  ['lev_mas', 'MAS', 'MASTER'],
  ['lev_remas', 'REM', 'Re:MASTER'],
  ['dx_lev_bas', 'DX_BAS', 'DX BASIC'],
  ['dx_lev_adv', 'DX_ADV', 'DX ADVANCED'],
  ['dx_lev_exp', 'DX_EXP', 'DX EXPERT'],
  ['dx_lev_mas', 'DX_MAS', 'DX MASTER'],
  ['dx_lev_remas', 'DX_REM', 'DX Re:MASTER'],
];

const CHUNITHM_COLUMNS: readonly SegaColumn[] = [
  ['lev_bas', 'BAS', 'BASIC'],
  ['lev_adv', 'ADV', 'ADVANCED'],
  ['lev_exp', 'EXP', 'EXPERT'],
  ['lev_mas', 'MAS', 'MASTER'],
  ['lev_ult', 'ULT', 'ULTIMA'],
];

const modesOf = (columns: readonly SegaColumn[]): SourceMode[] =>
  columns.map(([, code, label]) => ({ code, label }));

/**
 * 붙일 수 있는 출처 목록.
 *
 * 여기 없는 기종(IIDX · EZ2AC · 태고 · DDR …)은 공개 JSON 이 없어 HTML/위키를 읽어야
 * 합니다. 어댑터만 더하면 스크립트는 그대로 씁니다 — 같은 `ChartSource` 모양이면 됩니다.
 */
export const SOURCES: Record<string, ChartSource> = {
  maimai: {
    machineShortName: 'maimai',
    origin: 'maimai 공식 전곡 목록 (maimai.sega.jp/data/maimai_songs.json)',
    modes: modesOf(MAIMAI_COLUMNS),
    fetch: () => fetchSegaJson('https://maimai.sega.jp/data/maimai_songs.json', MAIMAI_COLUMNS),
  },
  chunithm: {
    machineShortName: '츄니즘',
    origin: 'CHUNITHM 공식 전곡 목록 (chunithm.sega.jp/storage/json/music.json)',
    modes: modesOf(CHUNITHM_COLUMNS),
    fetch: () =>
      fetchSegaJson('https://chunithm.sega.jp/storage/json/music.json', CHUNITHM_COLUMNS),
  },
};
