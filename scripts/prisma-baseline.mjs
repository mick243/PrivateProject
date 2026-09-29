/**
 * 이미 돌고 있는 DB 를 Prisma 마이그레이션 이력에 **얹습니다** (베이스라인).
 *
 *   node scripts/prisma-baseline.mjs --dry-run   무엇을 적용됨으로 표시할지만 출력
 *   node scripts/prisma-baseline.mjs             표시 (DDL 은 한 줄도 실행하지 않습니다)
 *
 * 왜 필요한가: 개발·운영 DB 에는 이미 89개 SQL 이 다 들어가 있습니다. 그 DB 에
 * `prisma migrate deploy` 를 그냥 돌리면 Prisma 는 "적용된 것이 하나도 없다" 고 보고
 * **처음부터 다시** 실행합니다. 그래서 먼저 `_prisma_migrations` 에 "이건 이미 됐다" 고
 * 적어 둡니다. 이 스크립트가 하는 일은 그 표시가 전부입니다.
 *
 * 무엇을 "이미 됐다" 로 볼지는 DB 에게 직접 묻습니다 (문서를 믿지 않습니다):
 *   - 스키마 그룹 파일 → 그 그룹의 sentinel 테이블이 있으면 적용됨
 *   - migrate-NNN.sql  → 옛 `schema_migrations` 에 이름이 있으면 적용됨
 * (뷰는 마이그레이션이 아닙니다 — 기동마다 다시 만들거나 `npm run db:views` 로 적용합니다.)
 * 그래서 절반만 적용된 DB 도 옳게 얹힙니다 — 나머지는 `migrate deploy` 가 이어서 합니다.
 *
 * ⚠ 옛 `schema_migrations` 테이블은 **건드리지 않습니다.** 되돌아갈 여지를 남깁니다
 *   (DB_CLIENT 를 비우면 옛 경로가 그대로 돕니다). 정리는 사람이 나중에 판단하세요.
 *
 * ⚠ 베이스라인은 DB 의 지금 상태를 **그대로 인정**합니다 — 스키마를 고치지 않습니다.
 *   개발 DB 에 빠져 있던 외래키 12개는 migrate-080 이 되돌리므로, 이 스크립트가 얹은
 *   뒤 `prisma migrate deploy` 가 080 을 적용합니다 (080 은 옛 이력에 없으니 미적용으로
 *   잡힙니다). 어긋남을 다시 재려면 `npm run db:prisma:drift`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_GROUPS, MIGRATION_FILES } from './db-files.mjs';
import { plan } from './prisma-migrations-build.mjs';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');

// .env.local 최소 파싱 — scripts/migrate.mjs 와 같은 방식 (dotenv 의존성 없이)
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다 — 이 스크립트는 PostgreSQL 전용입니다.');
  process.exit(2);
}

const masked = process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@');
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

/** Prisma 가 만드는 것과 같은 모양. 없을 때만 만듭니다. */
const PRISMA_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id                  VARCHAR(36)  PRIMARY KEY,
    checksum            VARCHAR(64)  NOT NULL,
    finished_at         TIMESTAMPTZ,
    migration_name      VARCHAR(255) NOT NULL,
    logs                TEXT,
    rolled_back_at      TIMESTAMPTZ,
    started_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    applied_steps_count INTEGER      NOT NULL DEFAULT 0
  );`;

try {
  const exists = async (name) => {
    const { rows } = await client.query(`SELECT to_regclass($1)::text AS r`, [`public.${name}`]);
    return Boolean(rows[0]?.r);
  };

  // 1. 옛 이력 읽기
  const legacyApplied = new Set();
  if (await exists('schema_migrations')) {
    const { rows } = await client.query(`SELECT name FROM schema_migrations`);
    for (const r of rows) legacyApplied.add(r.name);
  }

  // 2. 스키마 그룹은 sentinel 테이블로 판별
  const groupApplied = new Map();
  for (const group of SCHEMA_GROUPS) {
    const ok = await exists(group.sentinel);
    for (const file of group.files) groupApplied.set(file, ok);
  }

  const isApplied = (file) => {
    if (groupApplied.has(file)) return groupApplied.get(file);
    if (MIGRATION_FILES.includes(file)) return legacyApplied.has(file);
    return false;
  };

  // 3. 이미 Prisma 이력에 있는 것
  const alreadyMarked = new Set();
  if (await exists('_prisma_migrations')) {
    const { rows } = await client.query(`SELECT migration_name FROM "_prisma_migrations"`);
    for (const r of rows) alreadyMarked.add(r.migration_name);
  }

  const items = plan();
  const toMark = items.filter((m) => isApplied(m.file) && !alreadyMarked.has(m.folder));
  const pending = items.filter((m) => !isApplied(m.file));

  console.log(`대상: ${masked}`);
  console.log(
    `마이그레이션 ${items.length}개 · 이미 표시됨 ${alreadyMarked.size}개 · ` +
      `이번에 표시할 것 ${toMark.length}개 · DB 에 아직 없는 것 ${pending.length}개`,
  );
  for (const m of pending) console.log(`  · 미적용(그대로 둡니다): ${m.folder}`);

  if (dryRun) {
    console.log('(--dry-run — 아무것도 쓰지 않았습니다)');
  } else if (toMark.length) {
    await client.query(PRISMA_MIGRATIONS_TABLE);
    await client.query('BEGIN');
    try {
      for (const m of toMark) {
        await client.query(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES ($1, $2, now(), $3, $4, NULL, now(), 1)`,
          [
            crypto.randomUUID(),
            m.checksum,
            m.folder,
            // 나중에 이 행이 어디서 왔는지 사람이 알아볼 수 있게 남깁니다.
            'scripts/prisma-baseline.mjs — 기존 DB 를 얹은 것이며 이 SQL 은 실행되지 않았습니다',
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    console.log(`✔ ${toMark.length}개를 적용됨으로 표시했습니다. 이제 \`npx prisma migrate deploy\` 가 나머지만 적용합니다.`);
  } else {
    console.log('표시할 것이 없습니다 — 이미 얹혀 있습니다.');
  }
} finally {
  await client.end();
}
