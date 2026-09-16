/**
 * 기종별 수록곡·채보를 가져와 songs / charts 를 채웁니다.
 *
 *   npm run charts:import                        붙일 수 있는 출처 목록만 보기
 *   npm run charts:import -- maimai              미리보기 (DB 안 건드림)
 *   npm run charts:import -- maimai --write      반영
 *   npm run charts:import -- --all --write       등록된 출처 전부
 *
 * ─── 몇 번을 돌려도 같은 결과다 ───────────────────────────────
 * 곡은 (기종, 제목), 채보는 (곡, 모드, 층 이름)이 UNIQUE 입니다. 그 키로 upsert 하므로
 * 다시 돌리면 **새 곡·새 채보만 늘고 이미 있던 것은 난이도만 따라잡습니다.**
 * 수록곡이 계속 추가되는 게임들이라, 한 번 만들고 버리는 SQL 이 아니라 이 형태여야 합니다.
 *
 * ⚠ 지우지는 않습니다. 출처에서 사라진 곡(가동 종료 등)을 자동으로 지우면, 상대 서버가
 *   잠깐 형식을 바꾼 날 전곡이 날아갑니다. 사라진 것은 세어서 알려만 주고, 지우는 것은
 *   사람이 확인하고 합니다.
 *
 * ⚠ 서열표에는 바로 안 뜹니다. 서열표 게임 목록은 `tier_settings` 를 INNER JOIN 하므로
 *   (lib/tier.ts listGames), 설정·등급을 따로 넣기 전까지 이 기종은 서열표에
 *   나타나지 않습니다. 곡만 먼저 쌓아 두는 것이 안전해서 일부러 이렇게 뒀습니다.
 *
 * .ts 로 두는 이유는 scripts/import-arcades.ts 와 같습니다 — lib/ 의 코드를 그대로
 * 가져다 쓰기 위해서입니다.
 */

import { getDb } from '../lib/db.ts';
import { SOURCES, type ChartSource } from '../lib/chart-sources.ts';
import { describeTarget, loadScriptEnv } from '../lib/script-env.ts';

// 첫 getDb() 보다 먼저. 없으면 실 DB 대신 .pglite 에 조용히 들어간다.
loadScriptEnv();

const args = process.argv.slice(2);
const write = args.includes('--write');
const all = args.includes('--all');
const names = args.filter((a) => !a.startsWith('--'));

function usage(): void {
  console.log('붙일 수 있는 출처:\n');
  for (const [key, src] of Object.entries(SOURCES)) {
    console.log(`  ${key.padEnd(10)} ${src.machineShortName.padEnd(8)} ${src.origin}`);
  }
  console.log('\n  npm run charts:import -- <이름> [--write]');
  console.log('  npm run charts:import -- --all --write');
}

/** machines.short_name → id. 없으면 이름이 틀린 것이므로 멈춘다. */
async function machineIdOf(shortName: string): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM machines WHERE short_name = $1`,
    [shortName],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`machines 에 short_name='${shortName}' 이 없습니다`);
  return Number(id);
}

interface Tally {
  songsNew: number;
  chartsNew: number;
  chartsUpdated: number;
  dupTitles: string[];
  missing: string[];
}

async function applyOne(key: string, src: ChartSource): Promise<void> {
  console.log(`\n── ${key} — ${src.origin}`);
  const machineId = await machineIdOf(src.machineShortName);

  const songs = await src.fetch();
  const chartCount = songs.reduce((n, s) => n + s.charts.length, 0);
  console.log(`   받아온 것: 곡 ${songs.length} · 채보 ${chartCount}`);

  // 같은 제목이 여러 번 온 경우를 먼저 알린다 — songs 가 (기종, 제목) UNIQUE 라
  // 한 곡으로 합쳐지므로, 정말 다른 곡이면 사람이 봐야 한다.
  const seen = new Map<string, number>();
  for (const s of songs) seen.set(s.title, (seen.get(s.title) ?? 0) + 1);
  const dupTitles = [...seen].filter(([, n]) => n > 1).map(([t]) => t);

  const db = await getDb();

  // 출처에서 사라진 곡 — 지우지 않고 세기만 한다 (머리말 참고).
  const { rows: existing } = await db.query<{ title: string }>(
    `SELECT title FROM songs WHERE machine_id = $1`,
    [machineId],
  );
  const incoming = new Set(songs.map((s) => s.title));
  const missing = existing.map((r) => r.title).filter((t) => !incoming.has(t));

  const tally: Tally = { songsNew: 0, chartsNew: 0, chartsUpdated: 0, dupTitles, missing };

  if (!write) {
    // 미리보기에서도 '새 곡이 몇 곡인지' 는 알려 준다 — 그게 이 명령을 돌리는 이유다.
    const have = new Set(existing.map((r) => r.title));
    tally.songsNew = songs.filter((s) => !have.has(s.title)).length;
    report(key, tally, chartCount, false);
    return;
  }

  await db.transaction(async (tx) => {
    // 모드 목록부터 — 채보의 mode 가 machine_modes 에 없으면 화면이 코드를 날것으로 그린다.
    for (const [i, m] of src.modes.entries()) {
      await tx.query(
        `INSERT INTO machine_modes (machine_id, code, label, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (machine_id, code) DO UPDATE SET label = EXCLUDED.label`,
        [machineId, m.code, m.label, i + 1],
      );
    }

    for (const song of songs) {
      const { rows } = await tx.query<{ id: number; inserted: boolean }>(
        `INSERT INTO songs (machine_id, title, artist)
         VALUES ($1, $2, $3)
         ON CONFLICT (machine_id, title)
           DO UPDATE SET artist = COALESCE(EXCLUDED.artist, songs.artist)
         RETURNING id, (xmax = 0) AS inserted`,
        [machineId, song.title, song.artist],
      );
      const songId = Number(rows[0]!.id);
      if (rows[0]!.inserted) tally.songsNew += 1;

      for (const c of song.charts) {
        // level 만 갱신한다 — 투표·집계 컬럼은 손대지 않는다. 난이도 표기가 바뀌어도
        // (13 → 13+) 그건 **다른 층**이라 새 행이 되고, 옛 행은 사람이 정리한다.
        const { rows: cr } = await tx.query<{ inserted: boolean }>(
          // 열쇠에 version_id · difficulty 가 함께 들어갑니다 (migrate-059). 여기서
          // 넣는 채보는 둘 다 NULL 이지만, **추론은 제약의 컬럼 전부와 맞아야** 해서
          // 다섯 개를 그대로 적습니다 — 셋만 적으면 "matching the ON CONFLICT
          // specification" 을 못 찾아 임포터가 통째로 죽습니다.
          `INSERT INTO charts (song_id, mode, level, level_label)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (song_id, version_id, mode, difficulty, level_label)
             DO UPDATE SET level = EXCLUDED.level
           RETURNING (xmax = 0) AS inserted`,
          [songId, c.mode, c.level, c.levelLabel],
        );
        if (cr[0]!.inserted) tally.chartsNew += 1;
        else tally.chartsUpdated += 1;
      }
    }
  });

  report(key, tally, chartCount, true);
}

function report(key: string, t: Tally, chartCount: number, wrote: boolean): void {
  if (wrote) {
    console.log(`   반영: 새 곡 ${t.songsNew} · 새 채보 ${t.chartsNew} · 기존 채보 ${t.chartsUpdated}`);
  } else {
    console.log(`   미리보기: 새 곡 ${t.songsNew} (채보 ${chartCount}건은 --write 에서 반영)`);
  }
  if (t.dupTitles.length) {
    console.log(`   ⚠ 제목이 겹치는 항목 ${t.dupTitles.length}건 — 한 곡으로 합쳐집니다:`);
    for (const title of t.dupTitles.slice(0, 5)) console.log(`       ${title}`);
    if (t.dupTitles.length > 5) console.log(`       … 외 ${t.dupTitles.length - 5}건`);
  }
  if (t.missing.length) {
    console.log(`   ⚠ DB 에는 있는데 출처에 없는 곡 ${t.missing.length}건 — 지우지 않았습니다:`);
    for (const title of t.missing.slice(0, 5)) console.log(`       ${title}`);
    if (t.missing.length > 5) console.log(`       … 외 ${t.missing.length - 5}건`);
  }
  console.log(`   (${key} ${wrote ? '완료' : '미리보기 — --write 로 반영'})`);
}

const picked = all ? Object.keys(SOURCES) : names;
if (picked.length === 0) {
  usage();
  process.exit(0);
}

const unknown = picked.filter((k) => !(k in SOURCES));
if (unknown.length) {
  console.error(`모르는 출처: ${unknown.join(', ')}\n`);
  usage();
  process.exit(1);
}

console.log(`대상 DB: ${describeTarget()}`);
if (!write) console.log('※ 미리보기입니다 — DB 를 건드리지 않습니다 (--write 로 반영)');

for (const key of picked) {
  await applyOne(key, SOURCES[key]!);
}
console.log('\n끝났습니다.');
process.exit(0);
