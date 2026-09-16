/**
 * 비파괴 마이그레이션 — 운영 DB 에 **빠진 것만** 적용합니다.
 *
 *   npm run db:migrate                DATABASE_URL 의 PostgreSQL 에 적용
 *   npm run db:migrate -- --dry-run   무엇이 적용될지만 출력
 *
 * `db:init` 과의 차이: init 은 schema.sql 의 `DROP TABLE … CASCADE` 를 먼저 실행해
 * **모든 데이터를 지우고** 다시 만듭니다. 이 스크립트는 지우지 않습니다 —
 *   1. sentinel 테이블이 없는 스키마 그룹만 만들고
 *   2. `schema_migrations` 에 없는 마이그레이션만 순서대로 적용하고
 *   3. 뷰(views.sql)는 항상 다시 만듭니다 (데이터가 없어 안전)
 *
 * 서버(lib/db.ts)도 뜰 때 같은 일을 하므로 배포 후 첫 인스턴스가 대신 해 줍니다.
 * 이 스크립트는 **배포 전에 미리** 적용해 첫 요청의 지연·실패를 없애고, 무엇이
 * 바뀔지 사람이 먼저 보려는 자리입니다. 둘이 겹쳐도 advisory lock 으로 직렬화됩니다.
 *
 * ⚠ 되돌리기(down) 파일은 없습니다. 적용 전에 `pg_dump -Fc` 로 덤프를 떠 두세요
 *   (deploy/backup.sh). 마이그레이션 하나는 BEGIN/COMMIT 으로 묶여 있어 중간에
 *   실패하면 그 파일은 통째로 롤백되고 이력도 남지 않습니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DERIVED_SQL_FILE,
  MIGRATION_FILES,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_TABLE,
  SCHEMA_GROUPS,
} from './db-files.mjs';

const root = process.cwd();
const readSql = (f) => fs.readFileSync(path.join(root, 'db', f), 'utf8');

// .env.local 을 최소한으로 파싱 (dotenv 의존성 없이) — init-db.mjs 와 같은 방식
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const dryRun = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. PGlite 는 서버가 뜰 때 스스로 따라잡습니다 — 이 스크립트는 PostgreSQL 전용입니다.');
  process.exit(2);
}

const masked = process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@');
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

  // 1. 스키마 그룹 — sentinel 이 없는 것만
  const groupsToApply = [];
  for (const group of SCHEMA_GROUPS) {
    const { rows } = await client.query(`SELECT to_regclass($1)::text AS exists`, [
      `public.${group.sentinel}`,
    ]);
    if (!rows[0]?.exists) groupsToApply.push(group);
  }

  // 2. 마이그레이션 — 이력에 없는 것만
  await client.query(MIGRATIONS_TABLE);
  const { rows: appliedRows } = await client.query(`SELECT name FROM schema_migrations`);
  const applied = new Set(appliedRows.map((r) => r.name));
  const pending = MIGRATION_FILES.filter((f) => !applied.has(f));

  console.log(`대상: ${masked}`);
  console.log(
    `스키마 그룹 ${groupsToApply.length}개 · 마이그레이션 ${pending.length}개 · 뷰 1개(${DERIVED_SQL_FILE})`,
  );
  for (const g of groupsToApply) console.log(`  + 그룹 ${g.sentinel}: ${g.files.join(', ')}`);
  for (const f of pending) console.log(`  + ${f}`);

  if (dryRun) {
    console.log('(--dry-run — 적용하지 않았습니다)');
  } else {
    for (const group of groupsToApply) {
      for (const file of group.files) await client.query(readSql(file));
      console.log(`✔ 그룹 ${group.sentinel}`);
    }
    for (const file of pending) {
      // 파일 적용과 이력 기록을 한 트랜잭션으로 — lib/db.ts runMigrations 와 같은 모양
      await client.query(`BEGIN;
${readSql(file)}
INSERT INTO schema_migrations (name) VALUES ('${file}');
COMMIT;`);
      console.log(`✔ ${file}`);
    }
    await client.query(readSql(DERIVED_SQL_FILE));
    console.log(`✔ ${DERIVED_SQL_FILE}`);
    console.log('완료 — 지운 것은 없습니다.');
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
  await client.end();
}
