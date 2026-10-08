import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  arcadeKey,
  chartKey,
  fromJsonl,
  isInSync,
  modeKey,
  parseRelease,
  planImport,
  RELEASE_FORMAT,
  serializeRelease,
  songKey,
  toJsonl,
  USER_DATA_TABLES,
  type ArcadeRecord,
  type ImportTarget,
  type ReleaseData,
  type SongRecord,
} from '@/lib/data-release';
import { MIGRATION_FILES, SCHEMA_FILES } from '@/scripts/db-files.mjs';

/**
 * 데이터 릴리스 (lib/data-release.ts) — DB 없이 볼 수 있는 규칙만 고정합니다.
 * 실제 DB 로 돌린 왕복(개발 DB 사본 → 빈 DB, 2026-09-28)은 docs/DATA-SOURCES.md §4 에 있습니다.
 */

const arcade = (over: Partial<ArcadeRecord> = {}): ArcadeRecord => {
  const base = {
    source: 'localdata',
    sourceRef: 'localdata:youth:3000000:A-1',
    name: '픽스처오락실',
    address: '서울특별시 종로구 픽스처길 2',
    ...over,
  };
  return {
    key: arcadeKey(base),
    lat: 37.57,
    lng: 126.98,
    openTime: null,
    closeTime: null,
    is24h: false,
    phone: null,
    note: null,
    homepage: null,
    machines: [{ machine: 'Pump It Up', cabinets: [{ no: 1, condition: 4 }] }],
    guesses: [],
    ...base,
    ...over,
  };
};

const song = (over: Partial<SongRecord> = {}): SongRecord => ({
  machine: 'maimai DX',
  title: 'FIXTURE SONG',
  artist: 'Artist',
  charts: [{ version: null, mode: 'STD', difficulty: null, levelLabel: '13+', level: 13.5, videoUrl: null }],
  ...over,
});

const release = (over: Partial<ReleaseData> = {}): ReleaseData => ({
  arcades: [arcade()],
  modes: [{ machine: 'maimai DX', code: 'STD', label: 'スタンダード', sortOrder: 1 }],
  songs: [song()],
  ...over,
});

/** 빈 대상 — 마이그레이션만 적용한 DB (기종은 있고, 오락실·수입 곡은 없다) */
const emptyTarget = (): ImportTarget => ({
  machineIdByName: new Map([
    ['Pump It Up', 1],
    ['maimai DX', 7],
  ]),
  versionId: new Map(),
  arcades: new Map(),
  modes: new Map(),
  usedSortOrders: new Set(),
  songs: new Map(),
});

/** 릴리스를 그대로 넣은 뒤의 대상 */
function loaded(data: ReleaseData): ImportTarget {
  const t = emptyTarget();
  data.arcades.forEach((a, i) => {
    const { machines: _m, guesses: _g, ...record } = a;
    t.arcades.set(a.key, { id: i + 1, record });
  });
  for (const m of data.modes) {
    t.modes.set(modeKey(m), { label: m.label, sortOrder: m.sortOrder });
    t.usedSortOrders.add(`${m.machine}␟${m.sortOrder}`);
  }
  data.songs.forEach((s, i) => {
    t.songs.set(songKey(s), {
      id: i + 1,
      artist: s.artist,
      charts: new Map(s.charts.map((c, j) => [chartKey(c), { id: j + 1, level: c.level, videoUrl: c.videoUrl }])),
    });
  });
  return t;
}

describe('열쇠 — id 가 아니라 자연 키', () => {
  it('source_ref 가 있으면 그것이 열쇠다 (이름·주소가 바뀌어도 같은 곳)', () => {
    const a = arcadeKey({ source: 'naver', sourceRef: 'https://map.naver.com/p/search/x', name: 'A', address: 'B' });
    const b = arcadeKey({ source: 'naver', sourceRef: 'https://map.naver.com/p/search/x', name: 'A2', address: 'B2' });
    expect(a).toBe(b);
  });

  it('source_ref 가 없으면(수동 등록) 출처 + 이름 + 주소', () => {
    expect(arcadeKey({ source: 'manual', sourceRef: null, name: 'A', address: 'B' })).not.toBe(
      arcadeKey({ source: 'manual', sourceRef: null, name: 'A', address: 'C' }),
    );
  });

  it('채보 열쇠는 버전·모드·난이도·층 이름 — NULL 은 빈 칸으로 같은 값', () => {
    const c = { version: null, mode: 'STD', difficulty: null, levelLabel: '13+' };
    expect(chartKey(c)).toBe(chartKey({ ...c }));
    expect(chartKey(c)).not.toBe(chartKey({ ...c, levelLabel: '13' }));
  });
});

describe('파일 — JSONL + 매니페스트', () => {
  it('JSONL 왕복이 같은 값을 돌려준다', () => {
    const rows = [{ a: 1, s: '한글 "따옴표"' }, { a: 2, s: null }];
    expect(fromJsonl(toJsonl(rows))).toEqual(rows);
    expect(toJsonl([])).toBe('');
  });

  it('같은 데이터는 언제 내보내도 같은 sha256 — 시각은 매니페스트에만 있다', () => {
    const src = { database: 'dev', pendingMigrations: 0, repoMigrationHead: null };
    const a = serializeRelease(release(), src, '2026-01-01T00:00:00.000Z');
    const b = serializeRelease(release(), src, '2026-09-28T00:00:00.000Z');
    expect(a.manifest.files).toEqual(b.manifest.files);
    expect(a.manifest.format).toBe(RELEASE_FORMAT);
  });

  it('파일이 한 글자라도 바뀌면 읽기를 거부한다 — 덜 복사된 릴리스를 넣지 않게', () => {
    const { texts, manifest } = serializeRelease(release(), { database: 'dev', pendingMigrations: 0, repoMigrationHead: null });
    expect(parseRelease(manifest, texts)).toEqual(release());
    expect(() => parseRelease(manifest, { ...texts, arcades: texts.arcades.replace('픽스처', '픽스쳐') })).toThrow(/sha256/);
    expect(() => parseRelease({ ...manifest, format: 'other/9' }, texts)).toThrow(/형식/);
  });

  it('매니페스트 요약이 출처별로 센다', () => {
    const data = release({
      arcades: [arcade(), arcade({ source: 'naver', sourceRef: 'https://map.naver.com/p/search/y', name: 'N' })],
    });
    const { manifest } = serializeRelease(data, { database: 'dev', pendingMigrations: 0, repoMigrationHead: null });
    expect(manifest.summary.arcadesBySource).toEqual({ localdata: 1, naver: 1 });
    expect(manifest.summary.catalog['maimai DX']).toEqual({ songs: 1, charts: 1, modes: 1 });
    expect(Object.keys(manifest.excluded)).toEqual(expect.arrayContaining([...USER_DATA_TABLES.filter((t) => t !== 'arcade_review_summaries')]));
  });
});

describe('적재 계획 — 더하기만 한다', () => {
  it('빈 대상에는 전부 넣는다 (새 곡의 채보는 곡에 딸려 들어간다)', () => {
    const plan = planImport(release(), emptyTarget());
    expect(plan.arcades.insert).toHaveLength(1);
    expect(plan.modes.insert).toHaveLength(1);
    expect(plan.songs.insert).toHaveLength(1);
    expect(plan.charts.insert).toHaveLength(0);
    expect(isInSync(plan)).toBe(false);
  });

  it('다 넣은 대상은 같다 — 두 번째 적재는 아무것도 하지 않는다', () => {
    const data = release();
    const plan = planImport(data, loaded(data));
    expect(isInSync(plan)).toBe(true);
    expect(plan.arcades.same).toBe(1);
    expect(plan.charts.same).toBe(1);
  });

  it('원천 칸이 다르면 "다름" 으로 알려 준다 (고치는 것은 --update 일 때만)', () => {
    const data = release();
    const target = loaded(data);
    const moved = release({ arcades: [arcade({ lat: 37.6 })] });
    const plan = planImport(moved, target);
    expect(plan.arcades.changed).toEqual([{ key: data.arcades[0].key, fields: ['lat'] }]);
  });

  it('원천이 작곡가를 비워 보내면 다름이 아니다 — 대상의 값을 지킨다 (수입기와 같은 규칙)', () => {
    const data = release();
    const plan = planImport(release({ songs: [song({ artist: null })] }), loaded(data));
    expect(plan.songs.changed).toEqual([]);
  });

  it('있는 곡에 빠진 채보는 곡과 따로 가리킨다', () => {
    const data = release();
    const more = release({
      songs: [song({ charts: [...song().charts, { version: null, mode: 'DX', difficulty: null, levelLabel: '14', level: 14, videoUrl: null }] })],
    });
    const plan = planImport(more, loaded(data));
    expect(plan.charts.insert).toHaveLength(1);
    expect(plan.charts.insert[0]).toMatchObject({ machine: 'maimai DX', songKey: songKey(song()), chart: { mode: 'DX' } });
  });

  it('대상에만 있는 오락실은 지우지 않고 알린다 — 가상(seed) 오락실은 세지 않는다', () => {
    const target = loaded(release());
    const extra = arcade({ sourceRef: 'localdata:youth:3000000:ONLY-TARGET' });
    const seed = arcade({ source: 'seed', sourceRef: null, name: '(가상) 오락실' });
    for (const [i, a] of [extra, seed].entries()) {
      const { machines: _m, guesses: _g, ...record } = a;
      target.arcades.set(a.key, { id: 100 + i, record });
    }
    const plan = planImport(release(), target);
    expect(plan.arcades.extra).toEqual([extra.key]);
  });

  it('대상에 없는 기종·버전·모드 순서 충돌을 미리 드러낸다', () => {
    const target = emptyTarget();
    target.usedSortOrders.add('maimai DX␟1');
    const data = release({
      songs: [song({ machine: 'maimai DX', charts: [{ version: 'BUDDIES', mode: 'STD', difficulty: null, levelLabel: '13', level: 13, videoUrl: null }] })],
      arcades: [arcade({ machines: [{ machine: '없는 기종', cabinets: [] }] })],
    });
    const plan = planImport(data, target);
    expect(plan.missingMachines).toEqual(['없는 기종']);
    expect(plan.missingVersions).toEqual(['maimai DX BUDDIES']);
    expect(plan.modes.conflicts).toHaveLength(1);
  });
});

describe('마이그레이션과 데이터의 경계', () => {
  /**
   * 마이그레이션은 사용자 데이터를 **만들지** 않습니다. 옛 파일 여섯은 서열표 배치·화면 시연을
   * 위해 가상 플레이어·투표·글을 넣었고, 그 행들이 빈 DB 에 migrate deploy 를 돌린 운영 DB 에도
   * 그대로 들어갑니다(2026-09-28 실측: 가상 계정 12 · 투표 77 · 글 30). 이미 적용된 파일은 고칠 수
   * 없으므로(체크섬) 목록으로 묶어 두고, 새 파일은 막습니다. UPDATE · DELETE 는 허용합니다 — 투표
   * 척도를 바꾸는 것처럼 이미 있는 사용자 데이터를 고치는 것은 마이그레이션이 할 일입니다.
   */
  const GRANDFATHERED = new Set([
    'seed-tier.sql',
    'seed-community.sql',
    'seed-board.sql',
    'migrate-012-piu-s1-tier.sql',
    'migrate-020-restore-saranga-chart.sql',
    'migrate-049-verse-iv-a-tier.sql',
  ]);
  const insertsUserData = new RegExp(`^\\s*INSERT\\s+INTO\\s+(${USER_DATA_TABLES.join('|')})\\b`, 'im');
  const files = [...SCHEMA_FILES, ...MIGRATION_FILES];
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'db', f), 'utf8');

  it('새 마이그레이션은 사용자 데이터 표에 행을 넣지 않는다', () => {
    const offenders = files.filter((f) => !GRANDFATHERED.has(f) && insertsUserData.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('예외 목록이 실제로 필요한 것만 담고 있다 — 고쳐진 파일이 목록에 남아 규칙이 헛돌지 않게', () => {
    const stale = [...GRANDFATHERED].filter((f) => !insertsUserData.test(read(f)));
    expect(stale).toEqual([]);
  });
});
