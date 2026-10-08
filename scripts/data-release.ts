/**
 * 데이터 릴리스 — 외부 원천에서 온 데이터를 **사용자 데이터 없이** 다른 DB 로 옮깁니다.
 *
 *   npm run data:release -- report                     이 DB 의 데이터가 어디서 왔는지 (읽기만)
 *   npm run data:release -- export [--out <폴더>]      릴리스를 파일로 (읽기만 · 기본 backups/data-release/<시각>/)
 *   npm run data:release -- verify <폴더>              이 DB 가 릴리스를 다 갖고 있는지 대조 (읽기만)
 *   npm run data:release -- import <폴더>              무엇을 넣을지 미리보기 (쓰지 않음)
 *   npm run data:release -- import <폴더> --write      넣기 — 없는 것만 더합니다
 *   npm run data:release -- import <폴더> --write --update   원천 칸이 달라진 행도 고칩니다
 *
 * 무엇을 담고 무엇을 빼는지, 왜 id 가 아니라 자연 키인지는 lib/data-release.ts 머리말.
 * 새 운영 DB 를 채우는 순서는 docs/DATA-SOURCES.md §4:
 *
 *   npm run db:migrate:prisma            스키마 + 기준 데이터 (마이그레이션)
 *   npm run db:purge-demo -- --apply     마이그레이션의 시드가 넣은 가상 오락실·글 치우기
 *   npm run data:release -- import <폴더> --write
 *   npm run data:release -- verify <폴더>
 *
 * ⚠ 릴리스 폴더는 **커밋하지 않습니다** (backups/ 는 .gitignore). 네이버 지역 검색 결과가 들어
 *   있어 공개 저장소에 올릴 수 없습니다 — docs/DATA-SOURCES.md §3.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SOURCES } from '../lib/chart-sources.ts';
import {
  applyRelease,
  describeDatabase,
  isInSync,
  parseRelease,
  planAgainst,
  readRelease,
  RELEASE_FILES,
  serializeRelease,
  type ImportPlan,
  type Manifest,
  type ReleaseFileKey,
} from '../lib/data-release.ts';
import { getPrismaClient, migrationNames, pendingMigrations } from '../lib/prisma.ts';
import { describeTarget, loadScriptEnv } from '../lib/script-env.ts';

loadScriptEnv();

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const valueOf = (flag: string): string | null => {
  const i = rest.indexOf(flag);
  return i >= 0 ? (rest[i + 1] ?? null) : null;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--out');

const root = process.cwd();
/** 채보 수입기가 채우는 기종 — 이 기종들의 곡·채보는 마이그레이션에 없습니다 */
const CATALOG = [...new Set(Object.values(SOURCES).map((s) => s.machineShortName))];

const n = (v: number) => v.toLocaleString('ko-KR');

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function usage(): never {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*|^ \* ?/gm, ''));
  process.exit(command ? 1 : 0);
}

function databaseName(): string {
  const url = process.env.DATABASE_URL ?? '';
  // 호스트·계정은 매니페스트에 남기지 않습니다 — DB 이름만.
  return url.replace(/\?.*$/, '').split('/').pop() || '(알 수 없음)';
}

function readReleaseDir(dir: string) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`${manifestPath} 가 없습니다 — export 로 만든 폴더를 주세요`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const texts = Object.fromEntries(
    (Object.keys(RELEASE_FILES) as ReleaseFileKey[]).map((k) => [k, fs.readFileSync(path.join(dir, RELEASE_FILES[k]), 'utf8')]),
  ) as Record<ReleaseFileKey, string>;
  try {
    return { manifest, data: parseRelease(manifest, texts) };
  } catch (e) {
    fail((e as Error).message);
  }
}

function printPlan(plan: ImportPlan, mode: 'verify' | 'import'): void {
  const sample = (list: string[], max = 5) =>
    list.slice(0, max).map((s) => `      · ${s}`).join('\n') + (list.length > max ? `\n      … 외 ${n(list.length - max)}건` : '');
  const line = (label: string, insert: number, changed: number, same: number) =>
    console.log(`  ${label.padEnd(10)} 없음 ${n(insert).padStart(6)} · 다름 ${n(changed).padStart(5)} · 같음 ${n(same).padStart(6)}`);

  console.log(`\n${mode === 'verify' ? '대조' : '적재 계획'} (대상 기준 — "없음" 은 ${mode === 'verify' ? '대상에 빠진 것' : '넣을 것'})`);
  line('오락실', plan.arcades.insert.length, plan.arcades.changed.length, plan.arcades.same);
  line('모드', plan.modes.insert.length, plan.modes.changed.length, plan.modes.same);
  line('곡', plan.songs.insert.length, plan.songs.changed.length, plan.songs.same);
  line('채보(기존 곡)', plan.charts.insert.length, plan.charts.changed.length, plan.charts.same);
  const newSongCharts = plan.songs.insert.reduce((k, s) => k + s.charts.length, 0);
  if (newSongCharts) console.log(`  ${''.padEnd(10)} + 새 곡에 딸린 채보 ${n(newSongCharts)}`);

  if (plan.missingMachines.length) console.log(`\n  ⚠ 대상에 없는 기종: ${plan.missingMachines.join(', ')} — 마이그레이션부터`);
  if (plan.missingVersions.length) console.log(`  ⚠ 대상에 없는 버전(해당 채보는 건너뜀): ${plan.missingVersions.join(', ')}`);
  if (plan.modes.conflicts.length) console.log(`  ⚠ 모드 순서 충돌(건너뜀):\n${sample(plan.modes.conflicts)}`);
  if (plan.arcades.changed.length) {
    console.log(`  원천 칸이 다른 오락실${mode === 'import' ? ' (--update 일 때만 고칩니다)' : ''}:`);
    console.log(sample(plan.arcades.changed.map((c) => `${c.key} — ${c.fields.join(', ')}`)));
  }
  if (plan.arcades.extra.length) {
    console.log(`  대상에만 있는 오락실 ${n(plan.arcades.extra.length)}곳 (지우지 않습니다):`);
    console.log(sample(plan.arcades.extra));
  }
}

if (!['report', 'export', 'verify', 'import'].includes(command ?? '')) usage();

const prisma = await getPrismaClient();
console.log(`대상 DB: ${describeTarget()}`);

switch (command) {
  case 'report': {
    const r = await describeDatabase(prisma, CATALOG);
    console.log('\n오락실 — 출처별');
    for (const [src, count] of Object.entries(r.arcadesBySource).sort()) {
      const noRef = r.arcadesWithoutRef[src] ?? 0;
      console.log(`  ${src.padEnd(12)} ${n(count).padStart(6)}곳${noRef ? `  (source_ref 없음 ${n(noRef)})` : ''}`);
    }
    console.log('\n곡·채보 — 기종별 (수입기 = lib/chart-sources.ts, 그 밖은 마이그레이션)');
    for (const c of r.catalog) {
      console.log(`  ${c.machine.padEnd(28)} ${c.imported ? '수입기   ' : '마이그레이션'} 곡 ${n(c.songs).padStart(6)} · 채보 ${n(c.charts).padStart(6)}`);
    }
    console.log('\n사용자 데이터 (릴리스에 담지 않음)');
    for (const [t, count] of Object.entries(r.userData)) console.log(`  ${t.padEnd(18)} ${n(count).padStart(8)}`);
    console.log(`  로그인 수단 없는 계정 ${n(r.accountsWithoutLogin)} — 시드의 가상 투표자이거나 버려진 계정`);
    const pending = await pendingMigrations();
    console.log(`\n스키마: 저장소 마이그레이션 ${n(migrationNames().length)}개 중 미적용 ${n(pending.length)}개${pending.length ? ' (베이스라인 전이거나 뒤처진 DB)' : ''}`);
    break;
  }

  case 'export': {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const out = path.resolve(valueOf('--out') ?? path.join(root, 'backups', 'data-release', stamp));
    if (fs.existsSync(out) && fs.readdirSync(out).length) fail(`${out} 가 비어 있지 않습니다 — 릴리스는 덮어쓰지 않습니다`);

    const data = await readRelease(prisma, CATALOG);
    const pending = await pendingMigrations();
    const { texts, manifest } = serializeRelease(data, {
      database: databaseName(),
      pendingMigrations: pending.length,
      repoMigrationHead: migrationNames().at(-1) ?? null,
    });
    fs.mkdirSync(out, { recursive: true });
    for (const k of Object.keys(RELEASE_FILES) as ReleaseFileKey[]) fs.writeFileSync(path.join(out, RELEASE_FILES[k]), texts[k]);
    fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const s = manifest.summary;
    console.log(`\n릴리스를 만들었습니다 — ${out}`);
    console.log(`  오락실 ${n(data.arcades.length)}곳 (${Object.entries(s.arcadesBySource).map(([k, v]) => `${k} ${n(v)}`).join(' · ')})`);
    console.log(`         보유 기종 ${n(s.arcadeMachines)} · 기체 ${n(s.arcadeCabinets)} · AI 추정 ${n(s.machineGuesses)}`);
    for (const [m, c] of Object.entries(s.catalog)) console.log(`  ${m} — 곡 ${n(c.songs)} · 채보 ${n(c.charts)} · 모드 ${n(c.modes)}`);
    console.log(`  담지 않은 표 ${Object.keys(manifest.excluded).length}개 — manifest.json 의 excluded`);
    console.log('\n⚠ 이 폴더는 커밋하지 마세요 (네이버 검색 결과 포함 — docs/DATA-SOURCES.md §3).');
    break;
  }

  case 'verify':
  case 'import': {
    const dir = positional[0];
    if (!dir) usage();
    const { manifest, data } = readReleaseDir(path.resolve(dir));
    console.log(`릴리스: ${manifest.createdAt} · 원본 DB ${manifest.source.database} · 파일 대조 통과 (sha256)`);

    const pending = await pendingMigrations();
    if (pending.length) {
      const msg = `대상 DB 에 마이그레이션 ${n(pending.length)}개가 적용되지 않았습니다 (첫 번째: ${pending[0]}).`;
      if (command === 'import') fail(`${msg}\n  먼저 npm run db:migrate:prisma — 스키마가 저장소보다 뒤처진 DB 에는 넣지 않습니다.`);
      console.log(`⚠ ${msg} 대조는 계속합니다.`);
    }

    if (command === 'verify') {
      const plan = await planAgainst(prisma, data);
      printPlan(plan, 'verify');
      const ok = isInSync(plan);
      console.log(ok ? '\n✔ 대상이 이 릴리스를 전부 갖고 있습니다.' : '\n✖ 대상이 릴리스와 다릅니다 — 위 목록을 보세요.');
      process.exit(ok ? 0 : 1);
    }

    const write = flags.has('--write');
    const update = flags.has('--update');
    if (!write) {
      printPlan(await planAgainst(prisma, data), 'import');
      console.log('\n미리보기입니다 — 넣으려면 --write 를 붙이세요 (원천 칸까지 고치려면 --update 도).');
      break;
    }
    const { plan, result } = await applyRelease(prisma, data, { update });
    printPlan(plan, 'import');
    console.log(
      `\n✔ 넣었습니다 — 오락실 ${n(result.arcades)} (기종 ${n(result.arcadeMachines)} · 기체 ${n(result.arcadeCabinets)} · 추정 ${n(result.machineGuesses)})` +
        ` · 모드 ${n(result.modes)} · 곡 ${n(result.songs)} · 채보 ${n(result.charts)}`,
    );
    if (update) {
      const u = result.updated;
      console.log(`  고친 행 — 오락실 ${n(u.arcades)} · 모드 ${n(u.modes)} · 곡 ${n(u.songs)} · 채보 ${n(u.charts)}`);
    }
    console.log('  확인:  npm run data:release -- verify <같은 폴더>');
    break;
  }

  default:
    usage();
}

process.exit(0);
