/**
 * TypedSQL 모듈을 **저장소 안으로** 꺼내 둡니다 — `prisma/sql/*.sql` → `lib/typed-sql/*.ts`.
 *
 *   node scripts/prisma-typed-sql.mjs            다시 만들기 (DB 필요 — `prisma generate --sql`)
 *   node scripts/prisma-typed-sql.mjs --check    원본 SQL 과 어긋났는지만 봄 (DB 불필요)
 *
 * ─── 왜 필요했나 ─────────────────────────────────────────────
 * TypedSQL 은 **DB 에 붙어야** 타입을 만듭니다. `prisma generate --sql` 이 SQL 을 실제
 * PostgreSQL 에 PREPARE 해서 파라미터·결과 컬럼의 타입을 받아 오기 때문입니다. 그런데
 *
 *   · `npm ci` 의 postinstall 은 `prisma generate` (--sql 없음) — DB 없이 돌아야 합니다
 *   · CI·Vercel 빌드는 DB 없이 typecheck → build 를 돕니다
 *
 * 그래서 생성물이 gitignore(`lib/generated/`) 안에만 있으면, **새로 받은 저장소는 타입
 * 검사가 깨집니다** — 파일 8개에서 오류 41건입니다(`Cannot find module './generated/prisma/sql'`
 * 8건 + 그 여파로 결과 타입이 unknown 이 된 자리 33건. 2026-09-28 실측: 이관본 그대로에
 * `prisma generate` 만 돌린 상태). 이관을 한 워크트리에는 누군가 한 번 `--sql` 로 만든 파일이
 * 남아 있어 드러나지 않았습니다.
 *
 * ─── 어떻게 푸나 ─────────────────────────────────────────────
 * 생성된 모듈은 `@prisma/client/runtime/client` 하나만 import 하는 자립형 파일입니다
 * (생성된 클라이언트 폴더를 참조하지 않습니다). 그래서 그대로 꺼내 커밋해도 됩니다.
 * 대신 **생성물이 원본보다 낡는 것**을 막아야 합니다 — 모듈 안에 SQL 문자열이 박혀
 * 있어서, `.sql` 만 고치고 다시 만들지 않으면 실행되는 것은 **옛 SQL** 입니다.
 * 그래서 각 모듈 머리에 원본의 sha256 을 적고, `--check` 와 tests/typed-sql.test.ts 가
 * DB 없이 대조합니다.
 *
 * ⚠ 해시가 잡는 것은 "SQL 을 고쳤는데 다시 안 만들었다" 입니다. **테이블 컬럼 타입이
 *   바뀌어 결과 타입이 달라진 것**은 DB 에 붙어 다시 만들어야만 보입니다 — 마이그레이션을
 *   더한 뒤에는 `npm run db:prisma:sql` 을 한 번 돌리세요 (docs/PRISMA-MIGRATION.md §8).
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SQL_DIR = path.join(root, 'prisma', 'sql');
export const GENERATED_DIR = path.join(root, 'lib', 'generated', 'prisma', 'sql');
export const TYPED_SQL_DIR = path.join(root, 'lib', 'typed-sql');
export const INDEX_FILE = 'index.ts';

const HASH_RE = /^\/\/ source-sha256: ([0-9a-f]{64})$/m;

/** 줄바꿈을 LF 로 접은 뒤의 sha256 — 체크아웃한 장비의 autocrlf 에 따라 달라지면 안 됩니다 */
export function sourceHash(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** `prisma/sql/` 의 쿼리 이름들 (확장자 뺀 것, 사전순) */
export function queryNames() {
  if (!fs.existsSync(SQL_DIR)) return [];
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, -'.sql'.length))
    .sort();
}

export function readSource(name) {
  return fs.readFileSync(path.join(SQL_DIR, `${name}.sql`), 'utf8');
}

export function moduleHeader(name, hash) {
  return (
    `// 생성물 — 손으로 고치지 마세요. 원본: prisma/sql/${name}.sql\n` +
    `// source-sha256: ${hash}\n` +
    `// 다시 만들기: npm run db:prisma:sql (DB 필요) · 대조: npm run db:prisma:sql:check (DB 불필요)\n`
  );
}

export function indexSource(names) {
  return (
    `// 생성물 — scripts/prisma-typed-sql.mjs 가 씁니다. prisma/sql/*.sql 하나당 한 줄.\n` +
    // 확장자를 붙입니다 — scripts/ 의 .ts 도구가 번들러 없이 Node 로 직접 돌릴 수 있게 (lib/prisma.ts 와 같은 사정).
    names.map((n) => `export * from './${n}.ts';\n`).join('')
  );
}

/** 모듈 머리에 적힌 원본 해시. 없으면 null */
export function recordedHash(moduleText) {
  return HASH_RE.exec(moduleText)?.[1] ?? null;
}

/**
 * 모듈에 박힌 SQL 을 꺼냅니다 — `makeTypedQueryFactory("…")` 의 첫 인자.
 * 해시만 맞추고 본문을 손으로 고친 경우까지 잡으려는 두 번째 그물입니다.
 */
export function embeddedSql(moduleText) {
  const m = /makeTypedQueryFactory\(("(?:[^"\\]|\\.)*")\)/.exec(moduleText);
  return m ? JSON.parse(m[1]) : null;
}

/**
 * 비교용으로 SQL 을 접습니다. Prisma 는 모듈에 넣을 때 `--` 주석 줄을 빼고 줄마다 앞 공백을
 * 지웁니다(2026-09-28 · 7.10.0 에서 확인). 같은 규칙으로 양쪽을 접어 비교합니다.
 */
export function foldSql(sql) {
  return sql
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('--'))
    .join('\n');
}

/** 원본과 꺼내 둔 모듈을 대조합니다. 파일을 읽기만 합니다 */
export function check() {
  const names = queryNames();
  const missing = [];
  const stale = [];
  const edited = [];
  for (const name of names) {
    const file = path.join(TYPED_SQL_DIR, `${name}.ts`);
    if (!fs.existsSync(file)) {
      missing.push(name);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const source = readSource(name);
    if (recordedHash(text) !== sourceHash(source)) stale.push(name);
    else if (foldSql(embeddedSql(text) ?? '') !== foldSql(source)) edited.push(name);
  }

  const expected = new Set([...names.map((n) => `${n}.ts`), INDEX_FILE]);
  const orphan = fs.existsSync(TYPED_SQL_DIR)
    ? fs.readdirSync(TYPED_SQL_DIR).filter((f) => !expected.has(f))
    : [];

  const indexPath = path.join(TYPED_SQL_DIR, INDEX_FILE);
  const indexOk =
    fs.existsSync(indexPath) &&
    fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n') === indexSource(names);

  return { names, missing, stale, edited, orphan, indexOk };
}

function runPrismaGenerateSql() {
  // npx 대신 CLI 파일을 직접 — Windows 에서 shell 없이 .cmd 를 못 띄우는 문제를 피합니다.
  const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const r = spawnSync(process.execPath, [cli, 'generate', '--sql'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(
      '\n`prisma generate --sql` 이 실패했습니다. TypedSQL 은 DB 에 붙어야 타입을 만듭니다 —\n' +
        '.env.local 의 DATABASE_URL 이 마이그레이션까지 적용된 DB 를 가리키는지 보세요.',
    );
    process.exit(r.status ?? 1);
  }
}

function generate() {
  runPrismaGenerateSql();
  const names = queryNames();
  fs.mkdirSync(TYPED_SQL_DIR, { recursive: true });

  let written = 0;
  for (const name of names) {
    const generated = path.join(GENERATED_DIR, `${name}.ts`);
    if (!fs.existsSync(generated)) {
      console.error(`생성 결과에 ${name}.ts 가 없습니다 — prisma/sql/${name}.sql 의 문법을 확인하세요.`);
      process.exit(1);
    }
    const body = fs.readFileSync(generated, 'utf8').replace(/\r\n/g, '\n');
    const next = moduleHeader(name, sourceHash(readSource(name))) + body;
    const out = path.join(TYPED_SQL_DIR, `${name}.ts`);
    if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== next) {
      fs.writeFileSync(out, next);
      written += 1;
    }
  }

  fs.writeFileSync(path.join(TYPED_SQL_DIR, INDEX_FILE), indexSource(names));

  const { orphan } = check();
  for (const f of orphan) fs.rmSync(path.join(TYPED_SQL_DIR, f));

  console.log(`TypedSQL: 쿼리 ${names.length}개 · 새로 쓴 것 ${written}개 · 지운 것 ${orphan.length}개 → lib/typed-sql/`);
}

function main() {
  if (!process.argv.includes('--check')) return generate();

  const r = check();
  for (const n of r.missing) console.log(`  + ${n} — lib/typed-sql 에 없음`);
  for (const n of r.stale) console.log(`  ~ ${n} — 원본 SQL 이 바뀌었는데 다시 만들지 않음`);
  for (const n of r.edited) console.log(`  ! ${n} — 모듈의 SQL 이 원본과 다름 (손으로 고침?)`);
  for (const f of r.orphan) console.log(`  ? ${f} — 원본 없는 모듈`);
  if (!r.indexOk) console.log(`  ~ ${INDEX_FILE} — 목록이 원본과 다름`);
  const bad = r.missing.length + r.stale.length + r.edited.length + r.orphan.length + (r.indexOk ? 0 : 1);
  console.log(`대조: 쿼리 ${r.names.length}개 · 어긋남 ${bad}개${bad ? ' → npm run db:prisma:sql' : ''}`);
  if (bad) process.exit(1);
}

// 테스트는 함수만 가져다 씁니다 — import 했다고 파일을 쓰거나 prisma 를 띄우면 안 됩니다.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
