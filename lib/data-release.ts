import crypto from 'node:crypto';
import { BULK_TX_OPTIONS, type AppPrismaClient, type PrismaTx } from './prisma.ts';

/**
 * 데이터 릴리스 — **스키마가 아닌 데이터**를 환경 사이에 옮기는 형식과 규칙.
 * CLI 는 scripts/data-release.ts, 배경과 절차는 docs/DATA-SOURCES.md.
 *
 * ─── 왜 필요한가 (2026-09-28 실측) ───────────────────────────────
 * 빈 DB 에 마이그레이션 89개를 전부 적용해도 **실제 오락실은 0곳**입니다(시드의 가상 8곳뿐).
 * 오락실 926곳, maimai·CHUNITHM 곡 3,159 · 채보 13,193 은 외부 API 를 부른 스크립트가 개발 DB 에
 * **직접** 넣은 것이라 저장소 어디에도 없습니다. 지금까지 운영 DB 를 채우는 길은 개발 DB 를 통째로
 * pg_dump → pg_restore 하는 것뿐이었고(deploy/README.md), 그러면 개발하며 만든 계정·글·투표까지
 * 운영으로 넘어갑니다.
 *
 * ─── 규칙 ─────────────────────────────────────────────────────
 *   · 담는 것: **외부 원천에서 온 데이터** — 오락실(네이버·공공데이터·수동)과 그 보유 기종·기체·AI 기종
 *     추정, 채보 수입기(lib/chart-sources.ts SOURCES)가 채우는 기종의 곡·채보·모드.
 *   · 담지 않는 것: 사용자 데이터 · 마이그레이션이 넣는 기준 데이터 · 운영 중에 다시 생기는 값(EXCLUDED).
 *   · 열쇠는 **id 가 아니라 자연 키**입니다. 오락실 = source_ref(없으면 출처+이름+주소), 곡 = (기종
 *     이름, 제목), 채보 = (버전 코드, 모드, 난이도, 층 이름). 같은 곡이라도 DB 마다 id 가 다릅니다 —
 *     id 는 넣은 순서로 정해지는데, 개발 DB 는 maimai 를 EZ2DJ 마이그레이션보다 먼저 넣었습니다.
 *   · 적재는 **더하기만** 합니다. 대상에 없는 것만 넣고, 있는 것은 그대로 둡니다(`update` 면 원천에서
 *     온 칸만 고칩니다). 지우지 않습니다 — 운영에서는 사용자 제보가 보유 기종·기체를 바꿉니다.
 *   · 결정적입니다. 같은 DB 를 두 번 내보내면 파일이 바이트 단위로 같습니다(코드포인트 순 정렬 ·
 *     시각 칸 제외). 그래야 sha256 으로 "지난 릴리스와 같은가" 를 말할 수 있습니다.
 */

export const RELEASE_FORMAT = 'arcade-finder-data-release/1';

/** 파일 이름 — 매니페스트의 files 와 같은 이름 */
export const RELEASE_FILES = {
  arcades: 'arcades.jsonl',
  modes: 'catalog-modes.jsonl',
  songs: 'catalog-songs.jsonl',
} as const;
export type ReleaseFileKey = keyof typeof RELEASE_FILES;

/** 릴리스에 담지 않는 표와 그 이유 — 매니페스트에 그대로 적힙니다 */
export const EXCLUDED: Readonly<Record<string, string>> = {
  players: '사용자 계정',
  player_identities: '사용자 계정 (소셜 로그인 연결)',
  email_verifications: '사용자 계정 (인증 토큰)',
  posts: '사용자 글',
  post_comments: '사용자 글',
  post_likes: '사용자 글',
  post_images: '사용자 글 첨부',
  arcade_reviews: '사용자 리뷰',
  arcade_review_summaries: '사용자 리뷰의 AI 요약 — 리뷰 없이는 뜻이 없습니다',
  arcade_favorites: '사용자 즐겨찾기',
  machine_reports: '사용자 제보 (대기 제보는 4시간 뒤 지워집니다)',
  difficulty_votes: '사용자 투표',
  clear_records: '사용자 클리어 기록',
  chart_comments: '사용자 채보 평가',
  special_marks: '사용자 특수패턴 표시',
  login_failures: '운영 중에 생기는 값',
  rate_counters: '운영 중에 생기는 값',
  imported_news: '매일 sync-news 가 다시 가져옵니다',
  emoticons: '관리자가 올린 파일 — 파일이 uploads/ 에 있어 DB 만 옮기면 그림이 깨집니다',
  machines: '마이그레이션이 넣는 기준 데이터',
  game_versions: '마이그레이션이 넣는 기준 데이터',
  machine_difficulties: '마이그레이션이 넣는 기준 데이터',
  tier_settings: '마이그레이션이 넣는 기준 데이터',
  tier_grades: '마이그레이션이 넣는 기준 데이터',
  board_categories: '마이그레이션이 넣는 기준 데이터',
  report_settings: '마이그레이션이 넣는 기준 데이터',
  'songs · charts · machine_modes (수입기 밖의 기종)': '펌프·사볼·EZ2DJ 는 마이그레이션이 넣습니다',
};

/**
 * 사용자가 만드는 데이터가 사는 표. 릴리스에 담지 않고, **마이그레이션도 여기에 행을 만들지
 * 않습니다** (tests/data-release.test.ts 가 081 번부터 막습니다). 옛 시드와 012 · 020 · 049 는
 * 서열표 배치를 만들려고 가상 플레이어의 투표를 넣었고, 그 행들이 운영 DB 에도 그대로 들어갑니다
 * — docs/DATA-SOURCES.md §2.
 */
export const USER_DATA_TABLES = [
  'players',
  'player_identities',
  'email_verifications',
  'posts',
  'post_comments',
  'post_likes',
  'post_images',
  'arcade_reviews',
  'arcade_review_summaries',
  'arcade_favorites',
  'machine_reports',
  'difficulty_votes',
  'clear_records',
  'chart_comments',
  'special_marks',
] as const;

/** 가상(시연) 오락실의 출처 표시 — migrate-009. 릴리스에 넣지 않습니다 */
export const DEMO_ARCADE_SOURCE = 'seed';

// ─── 레코드 ─────────────────────────────────────────────────────

export interface ArcadeRecord {
  key: string;
  source: string | null;
  sourceRef: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  openTime: string | null;
  closeTime: string | null;
  is24h: boolean;
  phone: string | null;
  note: string | null;
  homepage: string | null;
  /** 보유 기종 (machines.name) 과 기체 */
  machines: { machine: string; cabinets: { no: number; condition: number | null }[] }[];
  /** AI 기종 추정 — 다시 만들려면 검색 호출 비용이 드는 값이라 함께 옮깁니다 */
  guesses: { machine: string; evidence: string; model: string }[];
}

export interface ChartRecord {
  /** game_versions.code */
  version: string | null;
  mode: string | null;
  difficulty: string | null;
  levelLabel: string;
  level: number | null;
  videoUrl: string | null;
}

export interface SongRecord {
  /** machines.name (short_name 은 유일하지 않습니다) */
  machine: string;
  title: string;
  artist: string | null;
  charts: ChartRecord[];
}

export interface ModeRecord {
  machine: string;
  code: string;
  label: string;
  sortOrder: number;
}

export interface ReleaseData {
  arcades: ArcadeRecord[];
  modes: ModeRecord[];
  songs: SongRecord[];
}

// ─── 열쇠 · 직렬화 ───────────────────────────────────────────────

const SEP = '␟'; // ␟ — 이름·주소에 나올 일이 없는 구분자

export function arcadeKey(a: { source: string | null; sourceRef: string | null; name: string; address: string }): string {
  return a.sourceRef ?? `${a.source ?? '(출처 없음)'}:${a.name}${SEP}${a.address}`;
}

export function songKey(s: { machine: string; title: string }): string {
  return `${s.machine}${SEP}${s.title}`;
}

export function chartKey(c: Pick<ChartRecord, 'version' | 'mode' | 'difficulty' | 'levelLabel'>): string {
  return [c.version ?? '', c.mode ?? '', c.difficulty ?? '', c.levelLabel].join(SEP);
}

export function modeKey(m: { machine: string; code: string }): string {
  return `${m.machine}${SEP}${m.code}`;
}

/** 코드포인트 순 — 로캘에 따라 순서가 바뀌면 같은 DB 가 다른 파일을 냅니다 */
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function fromJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(typeof v === 'object' ? String(v) : v);
  return Number.isFinite(n) ? n : null;
}

// ─── 내보내기 ───────────────────────────────────────────────────

/** 릴리스에 담을 데이터를 DB 에서 읽습니다. 읽기만 합니다 */
export async function readRelease(
  prisma: AppPrismaClient,
  catalogShortNames: readonly string[],
): Promise<ReleaseData> {
  const machines = await prisma.machines.findMany({ select: { id: true, name: true, short_name: true } });
  const nameOf = new Map(machines.map((m) => [m.id, m.name]));
  const machineName = (id: number) => {
    const name = nameOf.get(id);
    if (!name) throw new Error(`machines 에 id=${id} 가 없습니다`);
    return name;
  };
  const catalogIds = machines.filter((m) => catalogShortNames.includes(m.short_name)).map((m) => m.id);

  const arcadeRows = await prisma.arcades.findMany({
    // source <> 'seed' 는 NULL 을 거릅니다 — 출처가 비어 있는 행도 담고, 요약에서 따로 셉니다.
    where: { OR: [{ source: null }, { source: { not: DEMO_ARCADE_SOURCE } }] },
    select: {
      source: true,
      source_ref: true,
      name: true,
      address: true,
      lat: true,
      lng: true,
      open_time: true,
      close_time: true,
      is_24h: true,
      phone: true,
      note: true,
      homepage: true,
      arcade_machines: {
        select: {
          machine_id: true,
          arcade_cabinets: { select: { cabinet_no: true, condition: true } },
        },
      },
      arcade_machine_guesses: { select: { machine_id: true, evidence: true, model: true } },
    },
  });

  const arcades: ArcadeRecord[] = arcadeRows
    .map((a) => {
      const base = { source: a.source, sourceRef: a.source_ref, name: a.name, address: a.address };
      return {
        key: arcadeKey(base),
        ...base,
        lat: a.lat,
        lng: a.lng,
        openTime: a.open_time,
        closeTime: a.close_time,
        is24h: a.is_24h,
        phone: a.phone,
        note: a.note,
        homepage: a.homepage,
        machines: a.arcade_machines
          .map((m) => ({
            machine: machineName(m.machine_id),
            cabinets: m.arcade_cabinets
              .map((c) => ({ no: c.cabinet_no, condition: c.condition }))
              .sort((x, y) => x.no - y.no),
          }))
          .sort(byKey((m) => m.machine)),
        guesses: a.arcade_machine_guesses
          .map((g) => ({ machine: machineName(g.machine_id), evidence: g.evidence, model: g.model }))
          .sort(byKey((g) => g.machine)),
      };
    })
    .sort(byKey((a) => a.key));

  const modeRows = await prisma.machine_modes.findMany({
    where: { machine_id: { in: catalogIds } },
    select: { machine_id: true, code: true, label: true, sort_order: true },
  });
  const modes: ModeRecord[] = modeRows
    .map((m) => ({ machine: machineName(m.machine_id), code: m.code, label: m.label, sortOrder: m.sort_order }))
    .sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : a.sortOrder - b.sortOrder));

  const songRows = await prisma.songs.findMany({
    where: { machine_id: { in: catalogIds } },
    select: {
      machine_id: true,
      title: true,
      artist: true,
      charts: {
        select: {
          mode: true,
          level: true,
          level_label: true,
          difficulty: true,
          video_url: true,
          game_versions: { select: { code: true } },
        },
      },
    },
  });
  const songs: SongRecord[] = songRows
    .map((s) => ({
      machine: machineName(s.machine_id),
      title: s.title,
      artist: s.artist,
      charts: s.charts
        .map((c) => ({
          version: c.game_versions?.code ?? null,
          mode: c.mode,
          difficulty: c.difficulty,
          levelLabel: c.level_label,
          level: toNumber(c.level),
          videoUrl: c.video_url,
        }))
        .sort(byKey(chartKey)),
    }))
    .sort(byKey(songKey));

  return { arcades, modes, songs };
}

// ─── 매니페스트 ─────────────────────────────────────────────────

export interface ReleaseSummary {
  arcadesBySource: Record<string, number>;
  arcadeMachines: number;
  arcadeCabinets: number;
  machineGuesses: number;
  catalog: Record<string, { songs: number; charts: number; modes: number }>;
}

export interface Manifest {
  format: string;
  createdAt: string;
  source: {
    /** DB 이름만 — 호스트·계정은 적지 않습니다 */
    database: string;
    /** 내보낸 DB 에 적용되지 않은 저장소 마이그레이션 수 (베이스라인 전이면 전부) */
    pendingMigrations: number;
    /** 내보낸 시점 저장소의 마지막 마이그레이션 폴더 */
    repoMigrationHead: string | null;
  };
  files: Record<ReleaseFileKey, { file: string; rows: number; sha256: string }>;
  summary: ReleaseSummary;
  excluded: Readonly<Record<string, string>>;
}

export function summarize(data: ReleaseData): ReleaseSummary {
  const arcadesBySource: Record<string, number> = {};
  for (const a of data.arcades) {
    const k = a.source ?? '(출처 없음)';
    arcadesBySource[k] = (arcadesBySource[k] ?? 0) + 1;
  }
  const catalog: ReleaseSummary['catalog'] = {};
  const slot = (machine: string) => (catalog[machine] ??= { songs: 0, charts: 0, modes: 0 });
  for (const s of data.songs) {
    slot(s.machine).songs += 1;
    slot(s.machine).charts += s.charts.length;
  }
  for (const m of data.modes) slot(m.machine).modes += 1;
  return {
    arcadesBySource,
    arcadeMachines: data.arcades.reduce((n, a) => n + a.machines.length, 0),
    arcadeCabinets: data.arcades.reduce((n, a) => n + a.machines.reduce((k, m) => k + m.cabinets.length, 0), 0),
    machineGuesses: data.arcades.reduce((n, a) => n + a.guesses.length, 0),
    catalog,
  };
}

/** 파일 본문 세 개와 매니페스트. 쓰는 것은 CLI 가 합니다 */
export function serializeRelease(
  data: ReleaseData,
  source: Manifest['source'],
  createdAt = new Date().toISOString(),
): { texts: Record<ReleaseFileKey, string>; manifest: Manifest } {
  const texts: Record<ReleaseFileKey, string> = {
    arcades: toJsonl(data.arcades),
    modes: toJsonl(data.modes),
    songs: toJsonl(data.songs),
  };
  const files = Object.fromEntries(
    (Object.keys(RELEASE_FILES) as ReleaseFileKey[]).map((k) => [
      k,
      { file: RELEASE_FILES[k], rows: data[k].length, sha256: sha256(texts[k]) },
    ]),
  ) as Manifest['files'];
  return {
    texts,
    manifest: { format: RELEASE_FORMAT, createdAt, source, files, summary: summarize(data), excluded: EXCLUDED },
  };
}

/** 매니페스트와 파일 본문을 대조해 읽습니다. 한 글자라도 다르면 던집니다 — 깨진 릴리스를 넣지 않게 */
export function parseRelease(manifest: Manifest, texts: Record<ReleaseFileKey, string>): ReleaseData {
  if (manifest.format !== RELEASE_FORMAT) {
    throw new Error(`릴리스 형식이 다릅니다: ${manifest.format} (이 도구는 ${RELEASE_FORMAT})`);
  }
  for (const k of Object.keys(RELEASE_FILES) as ReleaseFileKey[]) {
    const got = sha256(texts[k]);
    if (got !== manifest.files[k].sha256) {
      throw new Error(`${RELEASE_FILES[k]} 의 sha256 이 매니페스트와 다릅니다 — 파일이 바뀌었거나 덜 복사됐습니다`);
    }
  }
  return {
    arcades: fromJsonl<ArcadeRecord>(texts.arcades),
    modes: fromJsonl<ModeRecord>(texts.modes),
    songs: fromJsonl<SongRecord>(texts.songs),
  };
}

// ─── 대조 · 적재 계획 ───────────────────────────────────────────

/** 원천에서 온 칸 — `update` 가 고치는 것은 이것뿐입니다 */
const ARCADE_FIELDS = ['name', 'address', 'lat', 'lng', 'openTime', 'closeTime', 'is24h', 'phone', 'note', 'homepage'] as const;

export interface Change {
  key: string;
  fields: string[];
}

export interface ImportPlan {
  missingMachines: string[];
  missingVersions: string[];
  arcades: { insert: ArcadeRecord[]; changed: Change[]; same: number; extra: string[] };
  modes: { insert: ModeRecord[]; changed: Change[]; same: number; conflicts: string[] };
  songs: { insert: SongRecord[]; changed: Change[]; same: number };
  /** 이미 있는 곡에 빠진 채보 · 원천 칸이 다른 채보 */
  charts: { insert: ChartRef[]; changed: (Change & ChartRef)[]; same: number };
}

/** 채보 하나를 가리키는 값 — 문자열을 다시 쪼개지 않도록 곡과 채보를 따로 듭니다 */
export interface ChartRef {
  machine: string;
  songKey: string;
  chart: ChartRecord;
}

/** 적재 계획을 세우는 데 필요한 대상 DB 의 상태 (planImport 의 입력 — 테스트는 직접 만듭니다) */
export type ImportTarget = {
  machineIdByName: Map<string, number>;
  versionId: Map<string, number>;
  arcades: Map<string, { id: number; record: Omit<ArcadeRecord, 'machines' | 'guesses'> }>;
  modes: Map<string, { label: string; sortOrder: number }>;
  usedSortOrders: Set<string>;
  songs: Map<string, { id: number; artist: string | null; charts: Map<string, { id: number; level: number | null; videoUrl: string | null }> }>;
};

async function readTarget(prisma: AppPrismaClient | PrismaTx, data: ReleaseData): Promise<ImportTarget> {
  const machines = await prisma.machines.findMany({ select: { id: true, name: true } });
  const machineIdByName = new Map(machines.map((m) => [m.name, m.id]));
  const nameOf = new Map(machines.map((m) => [m.id, m.name]));

  const catalogNames = [...new Set([...data.songs.map((s) => s.machine), ...data.modes.map((m) => m.machine)])];
  const catalogIds = catalogNames.map((n) => machineIdByName.get(n)).filter((id): id is number => id !== undefined);

  const versions = await prisma.game_versions.findMany({
    where: { machine_id: { in: catalogIds } },
    select: { id: true, machine_id: true, code: true },
  });
  const versionId = new Map(versions.map((v) => [`${nameOf.get(v.machine_id)}${SEP}${v.code}`, v.id]));

  const arcadeRows = await prisma.arcades.findMany({
    select: {
      id: true,
      source: true,
      source_ref: true,
      name: true,
      address: true,
      lat: true,
      lng: true,
      open_time: true,
      close_time: true,
      is_24h: true,
      phone: true,
      note: true,
      homepage: true,
    },
  });
  const arcades = new Map(
    arcadeRows.map((a) => {
      const record = {
        key: arcadeKey({ source: a.source, sourceRef: a.source_ref, name: a.name, address: a.address }),
        source: a.source,
        sourceRef: a.source_ref,
        name: a.name,
        address: a.address,
        lat: a.lat,
        lng: a.lng,
        openTime: a.open_time,
        closeTime: a.close_time,
        is24h: a.is_24h,
        phone: a.phone,
        note: a.note,
        homepage: a.homepage,
      };
      return [record.key, { id: a.id, record }];
    }),
  );

  const modeRows = await prisma.machine_modes.findMany({
    where: { machine_id: { in: catalogIds } },
    select: { machine_id: true, code: true, label: true, sort_order: true },
  });
  const modes = new Map(
    modeRows.map((m) => [modeKey({ machine: nameOf.get(m.machine_id)!, code: m.code }), { label: m.label, sortOrder: m.sort_order }]),
  );
  const usedSortOrders = new Set(modeRows.map((m) => `${nameOf.get(m.machine_id)}${SEP}${m.sort_order}`));

  const songRows = await prisma.songs.findMany({
    where: { machine_id: { in: catalogIds } },
    select: {
      id: true,
      machine_id: true,
      title: true,
      artist: true,
      charts: {
        select: {
          id: true,
          mode: true,
          level: true,
          level_label: true,
          difficulty: true,
          video_url: true,
          game_versions: { select: { code: true } },
        },
      },
    },
  });
  const songs: ImportTarget['songs'] = new Map(
    songRows.map((s) => [
      songKey({ machine: nameOf.get(s.machine_id)!, title: s.title }),
      {
        id: s.id,
        artist: s.artist,
        charts: new Map(
          s.charts.map((c) => [
            chartKey({ version: c.game_versions?.code ?? null, mode: c.mode, difficulty: c.difficulty, levelLabel: c.level_label }),
            { id: c.id, level: toNumber(c.level), videoUrl: c.video_url },
          ]),
        ),
      },
    ]),
  );

  return { machineIdByName, versionId, arcades, modes, usedSortOrders, songs };
}

function diffFields<T extends object>(want: T, have: T, fields: readonly (keyof T)[]): string[] {
  return fields.filter((f) => want[f] !== have[f]).map(String);
}

/** 대상 DB 를 읽어 무엇을 넣고 무엇이 다른지 계산합니다. 쓰지 않습니다 */
export function planImport(data: ReleaseData, target: ImportTarget): ImportPlan {
  const needMachines = new Set<string>([
    ...data.arcades.flatMap((a) => [...a.machines.map((m) => m.machine), ...a.guesses.map((g) => g.machine)]),
    ...data.songs.map((s) => s.machine),
    ...data.modes.map((m) => m.machine),
  ]);
  const missingMachines = [...needMachines].filter((n) => !target.machineIdByName.has(n)).sort();

  const missingVersions = new Set<string>();
  for (const s of data.songs) {
    for (const c of s.charts) {
      if (c.version && !target.versionId.has(`${s.machine}${SEP}${c.version}`)) missingVersions.add(`${s.machine} ${c.version}`);
    }
  }

  const plan: ImportPlan = {
    missingMachines,
    missingVersions: [...missingVersions].sort(),
    arcades: { insert: [], changed: [], same: 0, extra: [] },
    modes: { insert: [], changed: [], same: 0, conflicts: [] },
    songs: { insert: [], changed: [], same: 0 },
    charts: { insert: [], changed: [], same: 0 },
  };

  const releaseArcadeKeys = new Set<string>();
  for (const a of data.arcades) {
    releaseArcadeKeys.add(a.key);
    const have = target.arcades.get(a.key);
    if (!have) {
      plan.arcades.insert.push(a);
      continue;
    }
    const fields = diffFields(a, have.record as ArcadeRecord, ARCADE_FIELDS);
    if (fields.length) plan.arcades.changed.push({ key: a.key, fields });
    else plan.arcades.same += 1;
  }
  // 대상에만 있는 것 — 가상(seed) 오락실은 셀 필요가 없습니다. 지우지 않고 알려만 줍니다.
  for (const [key, { record }] of target.arcades) {
    if (record.source !== DEMO_ARCADE_SOURCE && !releaseArcadeKeys.has(key)) plan.arcades.extra.push(key);
  }
  plan.arcades.extra.sort();

  for (const m of data.modes) {
    const have = target.modes.get(modeKey(m));
    if (!have) {
      if (target.usedSortOrders.has(`${m.machine}${SEP}${m.sortOrder}`)) {
        plan.modes.conflicts.push(`${m.machine} ${m.code} — 순서 ${m.sortOrder} 을 다른 모드가 쓰고 있습니다`);
      } else {
        plan.modes.insert.push(m);
      }
      continue;
    }
    if (have.label !== m.label) plan.modes.changed.push({ key: modeKey(m), fields: ['label'] });
    else plan.modes.same += 1;
  }

  for (const s of data.songs) {
    const k = songKey(s);
    const have = target.songs.get(k);
    if (!have) {
      plan.songs.insert.push(s);
      continue;
    }
    // 원천이 작곡가를 비워 보내면 있던 값을 지킵니다 (수입기와 같은 규칙).
    if (s.artist !== null && s.artist !== have.artist) plan.songs.changed.push({ key: k, fields: ['artist'] });
    else plan.songs.same += 1;

    for (const c of s.charts) {
      const ck = chartKey(c);
      const hc = have.charts.get(ck);
      const ref: ChartRef = { machine: s.machine, songKey: k, chart: c };
      if (!hc) {
        plan.charts.insert.push(ref);
        continue;
      }
      const fields: string[] = [];
      if (c.level !== hc.level) fields.push('level');
      if (c.videoUrl !== null && c.videoUrl !== hc.videoUrl) fields.push('videoUrl');
      if (fields.length) plan.charts.changed.push({ key: `${k}${SEP}${ck}`, fields, ...ref });
      else plan.charts.same += 1;
    }
  }

  return plan;
}

/** 대상 DB 를 읽어 계획을 세웁니다 (verify 와 import --dry-run 이 함께 씁니다) */
export async function planAgainst(prisma: AppPrismaClient, data: ReleaseData): Promise<ImportPlan> {
  return planImport(data, await readTarget(prisma, data));
}

/** 대상이 릴리스를 다 갖고 있고 원천 칸이 같은가 — verify 의 합격 조건 */
export function isInSync(plan: ImportPlan): boolean {
  return (
    plan.missingMachines.length === 0 &&
    plan.arcades.insert.length === 0 &&
    plan.arcades.changed.length === 0 &&
    plan.modes.insert.length === 0 &&
    plan.modes.changed.length === 0 &&
    plan.songs.insert.length === 0 &&
    plan.songs.changed.length === 0 &&
    plan.charts.insert.length === 0 &&
    plan.charts.changed.length === 0
  );
}

// ─── 적재 ───────────────────────────────────────────────────────

/** PostgreSQL 의 바인드 변수 한도(65,535)를 넘지 않게 나눠 넣습니다 */
function* chunks<T>(rows: readonly T[], size = 1000): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

export interface ImportResult {
  arcades: number;
  arcadeMachines: number;
  arcadeCabinets: number;
  machineGuesses: number;
  modes: number;
  songs: number;
  charts: number;
  updated: { arcades: number; modes: number; songs: number; charts: number };
}

/**
 * 계획대로 넣습니다 — **트랜잭션 하나**. 중간에 실패하면 아무것도 남지 않습니다.
 * 계획은 트랜잭션 안에서 다시 세웁니다 — 미리보기와 실행 사이에 누가 써도 그 상태를 기준으로.
 */
export async function applyRelease(
  prisma: AppPrismaClient,
  data: ReleaseData,
  opts: { update: boolean },
): Promise<{ plan: ImportPlan; result: ImportResult }> {
  return prisma.$transaction(async (tx) => {
    const target = await readTarget(tx, data);
    const plan = planImport(data, target);
    if (plan.missingMachines.length) {
      throw new Error(`대상 DB 에 없는 기종: ${plan.missingMachines.join(', ')} — 마이그레이션이 덜 됐습니다`);
    }
    const result: ImportResult = {
      arcades: 0,
      arcadeMachines: 0,
      arcadeCabinets: 0,
      machineGuesses: 0,
      modes: 0,
      songs: 0,
      charts: 0,
      updated: { arcades: 0, modes: 0, songs: 0, charts: 0 },
    };
    const mid = (name: string) => target.machineIdByName.get(name)!;
    const vid = (machine: string, code: string | null) =>
      code === null ? null : (target.versionId.get(`${machine}${SEP}${code}`) ?? undefined);

    // 모드 — 채보의 mode 가 machine_modes 에 없으면 화면이 코드를 날것으로 그립니다.
    for (const part of chunks(plan.modes.insert)) {
      const { count } = await tx.machine_modes.createMany({
        data: part.map((m) => ({ machine_id: mid(m.machine), code: m.code, label: m.label, sort_order: m.sortOrder })),
        skipDuplicates: true,
      });
      result.modes += count;
    }

    // 오락실 — 새 행만. 돌려받은 id 로 기종·기체·추정을 붙입니다.
    for (const part of chunks(plan.arcades.insert, 500)) {
      const created = await tx.arcades.createManyAndReturn({
        data: part.map((a) => ({
          name: a.name,
          address: a.address,
          lat: a.lat,
          lng: a.lng,
          open_time: a.openTime,
          close_time: a.closeTime,
          is_24h: a.is24h,
          phone: a.phone,
          note: a.note,
          homepage: a.homepage,
          source: a.source,
          source_ref: a.sourceRef,
        })),
        select: { id: true, source: true, source_ref: true, name: true, address: true },
      });
      result.arcades += created.length;
      const idOf = new Map(
        created.map((c) => [arcadeKey({ source: c.source, sourceRef: c.source_ref, name: c.name, address: c.address }), c.id]),
      );
      const machineRows = part.flatMap((a) => a.machines.map((m) => ({ arcade_id: idOf.get(a.key)!, machine_id: mid(m.machine) })));
      const cabinetRows = part.flatMap((a) =>
        a.machines.flatMap((m) =>
          m.cabinets.map((c) => ({ arcade_id: idOf.get(a.key)!, machine_id: mid(m.machine), cabinet_no: c.no, condition: c.condition })),
        ),
      );
      const guessRows = part.flatMap((a) =>
        a.guesses.map((g) => ({ arcade_id: idOf.get(a.key)!, machine_id: mid(g.machine), evidence: g.evidence, model: g.model })),
      );
      if (machineRows.length) result.arcadeMachines += (await tx.arcade_machines.createMany({ data: machineRows })).count;
      if (cabinetRows.length) result.arcadeCabinets += (await tx.arcade_cabinets.createMany({ data: cabinetRows })).count;
      if (guessRows.length) result.machineGuesses += (await tx.arcade_machine_guesses.createMany({ data: guessRows })).count;
    }

    // 곡 — 새 곡과 그 채보, 그리고 이미 있는 곡에 빠진 채보.
    const songId = new Map([...target.songs].map(([k, s]) => [k, s.id]));
    const machineNameOf = new Map([...target.machineIdByName].map(([n, id]) => [id, n]));
    for (const part of chunks(plan.songs.insert)) {
      const created = await tx.songs.createManyAndReturn({
        data: part.map((s) => ({ machine_id: mid(s.machine), title: s.title, artist: s.artist })),
        select: { id: true, machine_id: true, title: true },
      });
      result.songs += created.length;
      for (const c of created) songId.set(songKey({ machine: machineNameOf.get(c.machine_id)!, title: c.title }), c.id);
    }
    const chartRows: { song_id: number; version_id: number | null; mode: string | null; difficulty: string | null; level_label: string; level: number | null; video_url: string | null }[] = [];
    const pushChart = ({ machine, songKey: key, chart: c }: ChartRef) => {
      const version = vid(machine, c.version);
      if (version === undefined) return; // 버전이 대상에 없음 — missingVersions 에 이미 적혀 있습니다
      chartRows.push({
        song_id: songId.get(key)!,
        version_id: version,
        mode: c.mode,
        difficulty: c.difficulty,
        level_label: c.levelLabel,
        level: c.level,
        video_url: c.videoUrl,
      });
    };
    for (const s of plan.songs.insert) for (const c of s.charts) pushChart({ machine: s.machine, songKey: songKey(s), chart: c });
    for (const ref of plan.charts.insert) pushChart(ref);
    for (const part of chunks(chartRows)) result.charts += (await tx.charts.createMany({ data: part })).count;

    if (opts.update) {
      const releaseArcades = new Map(data.arcades.map((a) => [a.key, a]));
      for (const ch of plan.arcades.changed) {
        const a = releaseArcades.get(ch.key)!;
        await tx.arcades.update({
          where: { id: target.arcades.get(ch.key)!.id },
          data: {
            name: a.name,
            address: a.address,
            lat: a.lat,
            lng: a.lng,
            open_time: a.openTime,
            close_time: a.closeTime,
            is_24h: a.is24h,
            phone: a.phone,
            note: a.note,
            homepage: a.homepage,
            updated_at: new Date(),
          },
        });
        result.updated.arcades += 1;
      }
      const releaseModes = new Map(data.modes.map((m) => [modeKey(m), m]));
      for (const ch of plan.modes.changed) {
        const m = releaseModes.get(ch.key)!;
        await tx.machine_modes.update({
          where: { machine_id_code: { machine_id: mid(m.machine), code: m.code } },
          data: { label: m.label },
        });
        result.updated.modes += 1;
      }
      const releaseSongs = new Map(data.songs.map((s) => [songKey(s), s]));
      for (const ch of plan.songs.changed) {
        const s = releaseSongs.get(ch.key)!;
        await tx.songs.update({ where: { id: target.songs.get(ch.key)!.id }, data: { artist: s.artist } });
        result.updated.songs += 1;
      }
      for (const ch of plan.charts.changed) {
        const have = target.songs.get(ch.songKey)!.charts.get(chartKey(ch.chart))!;
        await tx.charts.update({
          where: { id: have.id },
          data: { level: ch.chart.level, ...(ch.chart.videoUrl === null ? {} : { video_url: ch.chart.videoUrl }) },
        });
        result.updated.charts += 1;
      }
    }

    return { plan, result };
  }, BULK_TX_OPTIONS);
}

// ─── DB 한 곳의 데이터 구성 (report) ──────────────────────────────

export interface DatabaseReport {
  arcadesBySource: Record<string, number>;
  arcadesWithoutRef: Record<string, number>;
  catalog: { machine: string; imported: boolean; songs: number; charts: number }[];
  userData: Record<string, number>;
  /** 로그인 수단이 없는 계정 — 시드가 만든 가상 투표자이거나 버려진 계정 */
  accountsWithoutLogin: number;
}

/** 이 DB 의 데이터가 어디서 왔는지 한눈에. 읽기만 합니다 */
export async function describeDatabase(
  prisma: AppPrismaClient,
  catalogShortNames: readonly string[],
): Promise<DatabaseReport> {
  const bySource = await prisma.arcades.groupBy({ by: ['source'], _count: { _all: true } });
  const noRef = await prisma.arcades.groupBy({ by: ['source'], where: { source_ref: null }, _count: { _all: true } });
  const label = (s: string | null) => s ?? '(출처 없음)';

  const machines = await prisma.machines.findMany({
    select: { name: true, short_name: true, _count: { select: { songs: true } } },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
  const chartCounts = await prisma.songs.findMany({
    select: { machines: { select: { name: true } }, _count: { select: { charts: true } } },
  });
  const chartsBy = new Map<string, number>();
  for (const s of chartCounts) chartsBy.set(s.machines.name, (chartsBy.get(s.machines.name) ?? 0) + s._count.charts);

  const [players, posts, comments, reviews, votes, clears, reports, favorites, chartComments] = await Promise.all([
    prisma.players.count(),
    prisma.posts.count(),
    prisma.post_comments.count(),
    prisma.arcade_reviews.count(),
    prisma.difficulty_votes.count(),
    prisma.clear_records.count(),
    prisma.machine_reports.count(),
    prisma.arcade_favorites.count(),
    prisma.chart_comments.count(),
  ]);
  const accountsWithoutLogin = await prisma.players.count({
    where: { password_hash: null, player_identities: { none: {} } },
  });

  return {
    arcadesBySource: Object.fromEntries(bySource.map((r) => [label(r.source), r._count._all])),
    arcadesWithoutRef: Object.fromEntries(noRef.map((r) => [label(r.source), r._count._all])),
    catalog: machines
      .filter((m) => m._count.songs > 0 || catalogShortNames.includes(m.short_name))
      .map((m) => ({
        machine: m.name,
        imported: catalogShortNames.includes(m.short_name),
        songs: m._count.songs,
        charts: chartsBy.get(m.name) ?? 0,
      })),
    userData: {
      players,
      posts,
      post_comments: comments,
      arcade_reviews: reviews,
      difficulty_votes: votes,
      clear_records: clears,
      machine_reports: reports,
      arcade_favorites: favorites,
      chart_comments: chartComments,
    },
    accountsWithoutLogin,
  };
}
