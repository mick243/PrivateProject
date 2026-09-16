/**
 * DB 초기화 스크립트 — schema.sql + seed.sql 을 적용합니다.
 *
 *   npm run db:init                   기존 테이블을 드롭하고 다시 만듭니다 (파괴적)
 *   npm run db:reset                  .pglite 디렉터리까지 통째로 지우고 새로 만듭니다
 *   npm run db:reset -- --pglite      DATABASE_URL 이 있어도 로컬 사본에만 적용
 *   npm run db:init  -- --yes         실제 PostgreSQL 에 적용 (아래 가드 참고)
 *
 * DATABASE_URL 이 있으면 실제 Postgres 에, 없으면 .pglite 에 적용합니다.
 * `--pglite` 를 붙이면 DATABASE_URL 이 있어도 .pglite 에 적용합니다 —
 * 로컬 사본의 스키마를 만들 때 씁니다 (scripts/snapshot-pg-to-pglite.mjs).
 *
 * ─── 실제 PostgreSQL 에는 --yes 없이 못 간다 ──────────────────
 * 이 스크립트는 **테이블을 드롭하고 시드를 다시 넣습니다.** 로컬 사본에 하려던 것이
 * 실제 DB 로 가면 수집해 둔 오락실이 예시 데이터로 덮입니다 — 실제로 그렇게 927곳이
 * 8곳(가상)으로 바뀐 적이 있습니다.
 *
 * 특히 `DATABASE_URL= npm run db:reset` 로는 못 막습니다. 위 .env.local 파서가 빈
 * 문자열을 '없음' 으로 보고 파일 값으로 **다시 채워 넣기** 때문입니다. 로컬 사본을
 * 노렸다면 언제나 `--pglite` 입니다.
 *
 * 그래서 대상이 PostgreSQL 이면 무엇이 사라지는지 **행 수로 먼저 보여주고** 멈춥니다.
 * 그 화면을 보고도 하겠다면 `--yes` 를 붙입니다 (scripts/snapshot-pg-to-pglite.mjs 와
 * 같은 규칙).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DERIVED_SQL_FILE, MIGRATION_FILES, MIGRATIONS_TABLE, SCHEMA_FILES } from './db-files.mjs';

const root = process.cwd();
const readSql = (f) => fs.readFileSync(path.join(root, 'db', f), 'utf8');

// .env.local 을 최소한으로 파싱 (dotenv 의존성 없이)
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const reset = process.argv.includes('--reset');

// DATABASE_URL 을 무시하고 로컬 사본(.pglite)에 적용. 환경변수를 비워서 같은 효과를
// 내려고 하면 .env.local 파싱이 다시 채워 넣기 때문에 플래그로 받습니다.
const forcePglite = process.argv.includes('--pglite');

/** 실제 PostgreSQL 을 드롭·재시드해도 좋다는 확인 (머리말의 가드 참고) */
const yes = process.argv.includes('--yes');

// SQL 파일 목록은 scripts/db-files.mjs 에 있습니다 (migrate.mjs 와 공유).
// ⚠ 그 파일은 lib/db.ts 와 같아야 합니다 — tests/db-lists.test.ts 가 대조합니다.

/** exec/query 를 받아 전체 순서를 적용 */
async function applyAll(run) {
  for (const file of SCHEMA_FILES) await run(readSql(file));
  await run(MIGRATIONS_TABLE);
  for (const file of MIGRATION_FILES) {
    await run(readSql(file));
    await run(`INSERT INTO schema_migrations (name) VALUES ('${file}')
               ON CONFLICT (name) DO NOTHING;`);
  }
  await run(readSql(DERIVED_SQL_FILE));
}

if (process.env.DATABASE_URL && !forcePglite) {
  const { default: pg } = await import('pg');
  const masked = process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();

  // ── 가드: 무엇이 사라지는지 먼저 보여준다 ──────────────────────
  // 붙은 뒤에 세는 이유는, 지워질 것의 **실제 행 수**를 보여줘야 실수를 알아채기
  // 때문입니다. "정말 하시겠습니까" 는 습관적으로 넘기지만 '오락실 927' 은 눈에 띕니다.
  if (!yes) {
    const { rows } = await client.query(
      `SELECT c.relname AS table, c.reltuples::bigint AS approx
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [['arcades', 'arcade_machines', 'songs', 'charts', 'posts', 'players']],
    );
    await client.end();

    console.error(`✖ 대상이 실제 PostgreSQL 입니다 — ${masked}`);
    console.error('  이 명령은 테이블을 드롭하고 시드를 다시 넣습니다. 지금 들어 있는 것:');
    if (rows.length === 0) {
      console.error('    (아직 테이블이 없습니다)');
    } else {
      for (const r of rows) {
        // reltuples 는 통계 기반 추정치라 정확한 수가 아닙니다. 겁주기에는 충분하고,
        // 큰 테이블에서 COUNT(*) 로 몇 초를 쓰지 않습니다.
        const n = Number(r.approx);
        console.error(`    ${r.table.padEnd(16)} ${n < 0 ? '?' : `약 ${n.toLocaleString('ko-KR')}행`}`);
      }
    }
    console.error('');
    console.error('  로컬 사본에 하려던 것이라면:  npm run db:reset -- --pglite');
    console.error('  (DATABASE_URL= 로 비워도 .env.local 이 다시 채웁니다 — 플래그를 쓰세요)');
    console.error('  정말 이 PostgreSQL 을 초기화하려면 --yes 를 붙이세요.');
    process.exit(1);
  }

  await applyAll((sql) => client.query(sql));
  await client.end();
  console.log('✔ PostgreSQL 초기화 완료 —', masked);
} else {
  const dataDir = path.join(root, '.pglite');
  if (reset && fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('· .pglite 삭제됨');
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  await applyAll((sql) => db.exec(sql));
  await db.close();
  console.log('✔ PGlite 초기화 완료 — .pglite/');
  if (!process.env.DATABASE_URL) {
    console.log('  (실제 Postgres 를 쓰려면 .env.local 에 DATABASE_URL 을 설정하세요)');
  }
  if (reset) {
    // dev 서버는 PGlite 핸들을 캐시하고 있어 지워진 디렉터리를 계속 붙잡는다.
    console.log('  ⚠ dev 서버가 떠 있다면 재시작하세요 — 이전 DB 핸들을 잡고 있습니다.');
  }
}
