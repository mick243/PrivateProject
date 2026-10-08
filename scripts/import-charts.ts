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

import { SOURCES, type ChartSource } from '../lib/chart-sources.ts';
import { BULK_TX_OPTIONS, getPrismaClient } from '../lib/prisma.ts';
import { describeTarget, loadScriptEnv } from '../lib/script-env.ts';

// 첫 getPrismaClient() 보다 먼저 — DATABASE_URL 을 .env.local 에서 읽어 옵니다.
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
  const prisma = await getPrismaClient();
  const row = await prisma.machines.findFirst({
    where: { short_name: shortName },
    select: { id: true },
  });
  if (!row) throw new Error(`machines 에 short_name='${shortName}' 이 없습니다`);
  return row.id;
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

  const prisma = await getPrismaClient();

  // 출처에서 사라진 곡 — 지우지 않고 세기만 한다 (머리말 참고).
  const existing = await prisma.songs.findMany({
    where: { machine_id: machineId },
    select: { title: true },
  });
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

  await prisma.$transaction(async (tx) => {
    // 모드 목록부터 — 채보의 mode 가 machine_modes 에 없으면 화면이 코드를 날것으로 그린다.
    // 이미 있으면 이름만 따라잡습니다 (순서는 사람이 정한 값일 수 있어 두고).
    for (const [i, m] of src.modes.entries()) {
      await tx.machine_modes.upsert({
        where: { machine_id_code: { machine_id: machineId, code: m.code } },
        create: { machine_id: machineId, code: m.code, label: m.label, sort_order: i + 1 },
        update: { label: m.label },
      });
    }

    for (const song of songs) {
      // 열쇠는 (기종, 제목). 새 곡을 세야 해서 upsert 대신 찾고 나서 씁니다 — 옛 SQL 은
      // ON CONFLICT … RETURNING (xmax = 0) 으로 한 문장에 했습니다. 도구는 혼자 쓰므로
      // 찾기와 쓰기 사이에 끼어들 사람이 없습니다.
      const had = await tx.songs.findUnique({
        where: { machine_id_title: { machine_id: machineId, title: song.title } },
        select: { id: true },
      });
      let songId: number;
      if (had) {
        songId = had.id;
        // 출처가 작곡가를 비워 보내면 있던 값을 지킵니다 (옛 SQL 의 COALESCE(EXCLUDED.artist, songs.artist)).
        if (song.artist !== null) {
          await tx.songs.update({ where: { id: songId }, data: { artist: song.artist } });
        }
      } else {
        const created = await tx.songs.create({
          data: { machine_id: machineId, title: song.title, artist: song.artist },
          select: { id: true },
        });
        songId = created.id;
        tally.songsNew += 1;
      }

      for (const c of song.charts) {
        // level 만 갱신한다 — 투표·집계 컬럼은 손대지 않는다. 난이도 표기가 바뀌어도
        // (13 → 13+) 그건 **다른 층**이라 새 행이 되고, 옛 행은 사람이 정리한다.
        //
        // 열쇠는 (곡, 버전, 모드, 난이도, 층 이름) 이고 NULLS NOT DISTINCT 입니다 (migrate-059).
        // 여기서 넣는 채보는 버전·난이도가 NULL 인데, Prisma 의 복합 unique 입력은 NULL 을
        // 받지 않아 findFirst 로 찾습니다 — `version_id: null` 은 IS NULL 로 나갑니다.
        const chart = await tx.charts.findFirst({
          where: {
            song_id: songId,
            version_id: null,
            mode: c.mode,
            difficulty: null,
            level_label: c.levelLabel,
          },
          select: { id: true },
        });
        if (chart) {
          await tx.charts.update({ where: { id: chart.id }, data: { level: c.level } });
          tally.chartsUpdated += 1;
        } else {
          await tx.charts.create({
            data: { song_id: songId, mode: c.mode, level: c.level, level_label: c.levelLabel },
          });
          tally.chartsNew += 1;
        }
      }
    }
  }, BULK_TX_OPTIONS);

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
