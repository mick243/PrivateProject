/**
 * 뷰(`db/views.sql`)만 다시 만듭니다.
 *
 *   npm run db:views
 *
 * 뷰는 마이그레이션이 아닙니다 — 데이터가 없는 파생 객체라 언제 다시 만들어도 안전하고,
 * 그래서 서버가 뜰 때마다 DROP → CREATE 합니다 (lib/db.ts · db/views.sql 머리말).
 * Prisma 마이그레이션에도 넣지 않았습니다(scripts/prisma-migrations-build.mjs 참고).
 *
 * 이 스크립트가 필요한 자리는 하나입니다: **`prisma migrate deploy` 로 새 DB 를 만든
 * 직후.** 표는 다 생겼지만 뷰는 아직 없으므로, 앱을 띄우기 전에 조회하면 42P01 을 봅니다.
 * 앱을 한 번 띄우면 어차피 만들어지지만, 사람이 먼저 확인하고 싶을 때 씁니다.
 *
 * ⚠ 테이블·시드는 건드리지 않습니다. 지우는 것은 뷰뿐입니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DERIVED_SQL_FILE } from './db-files.mjs';

const root = process.cwd();

// .env.local 최소 파싱 — scripts/migrate.mjs 와 같은 방식
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const urlFlag = process.argv.indexOf('--url');
if (urlFlag !== -1 && process.argv[urlFlag + 1]) process.env.DATABASE_URL = process.argv[urlFlag + 1];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다. PGlite 는 서버가 뜰 때 스스로 만듭니다 — 이 스크립트는 PostgreSQL 전용입니다.');
  process.exit(2);
}

const masked = process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@');
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(fs.readFileSync(path.join(root, 'db', DERIVED_SQL_FILE), 'utf8'));
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1`,
  );
  console.log(`대상: ${masked}`);
  console.log(`✔ ${DERIVED_SQL_FILE} 적용 — 뷰 ${rows.length}개 (${rows.map((r) => r.table_name).join(', ')})`);
} finally {
  await client.end();
}
