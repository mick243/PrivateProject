import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DERIVED_SQL_FILE,
  MIGRATION_FILES,
  MIGRATION_LOCK_KEY,
  SCHEMA_GROUPS,
} from '@/scripts/db-files.mjs';

/**
 * `scripts/db-files.mjs` — SQL 파일 목록의 **유일한** 정본 — 이 db/ 폴더와 맞는지 봅니다.
 *
 * 사람이 손으로 맞추는 목록은 반드시 어긋나고, 어긋나면 **조용히** 어긋납니다 — 목록에 없는
 * 파일은 영원히 적용되지 않고, `db:init` 이 만든 DB 에는 이력만 남은 채 데이터가 비어 있게
 * 됩니다. 2026-08-24 에 030~036 이 빠져 실제로 그 상태가 됐습니다.
 *
 * 2026-09-28 까지는 같은 목록이 `lib/db.ts` 에도 있어 둘을 대조하는 테스트가 여기 있었습니다.
 * lib/db.ts 를 지우면서 목록이 하나가 됐고, 남은 대조는 둘입니다: 이 파일(db/ 폴더)과
 * tests/prisma-migrations.test.ts(prisma/migrations).
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbDir = path.join(root, 'db');

describe('db/ 폴더와 목록', () => {
  const onDisk = fs
    .readdirSync(dbDir)
    .filter((f) => f.startsWith('migrate-') && f.endsWith('.sql'))
    .sort();

  it('db/ 의 마이그레이션 파일이 모두 목록에 있다 — 목록에 없으면 영원히 적용되지 않는다', () => {
    expect(onDisk.filter((f) => !MIGRATION_FILES.includes(f))).toEqual([]);
  });

  it('목록의 모든 항목이 실제 파일이다 — 없으면 러너가 중간에 멈춘다', () => {
    expect(MIGRATION_FILES.filter((f) => !onDisk.includes(f))).toEqual([]);
  });

  it('번호가 겹치지 않고 오름차순이다 — 파일 이름 순서가 곧 적용 순서다', () => {
    const numbers = MIGRATION_FILES.map((f) => Number(f.slice('migrate-'.length, 'migrate-'.length + 3)));
    expect(numbers.filter((n, i) => numbers.indexOf(n) !== i)).toEqual([]);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('스키마·시드·뷰 파일이 실제로 있다', () => {
    const files = [...SCHEMA_GROUPS.flatMap((g) => g.files), DERIVED_SQL_FILE];
    expect(files.filter((f) => !fs.existsSync(path.join(dbDir, f)))).toEqual([]);
  });

  it('마이그레이션 잠금 키가 lib/prisma.ts 와 같다 — 다르면 서버와 러너가 서로를 기다리지 않는다', () => {
    const prismaTs = fs.readFileSync(path.join(root, 'lib', 'prisma.ts'), 'utf8');
    const key = /MIGRATION_LOCK_KEY\s*=\s*([\d_]+)/.exec(prismaTs)?.[1]?.replaceAll('_', '');
    expect(Number(key)).toBe(MIGRATION_LOCK_KEY);
  });
});
