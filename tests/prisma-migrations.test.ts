import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  MIGRATION_LOCK,
  ORDERED_FILES,
  plan,
  stripInitDrops,
} from '@/scripts/prisma-migrations-build.mjs';
import { DERIVED_SQL_FILE, MIGRATION_FILES, SCHEMA_FILES } from '@/scripts/db-files.mjs';

/**
 * `prisma/migrations/` 가 `db/` 와 어긋나지 않았는지 봅니다.
 *
 * tests/db-lists.test.ts 가 `scripts/db-files.mjs` 를 db/ 폴더와 대조하는 것과 같은
 * 자리입니다. 목록이 어긋나면 **조용히** 어긋나기 때문입니다 — 2026-08-24 에 030~036 이
 * 빠진 채 이력만 남아 데이터가 비어 있었습니다. 마이그레이션 폴더는 생성물이므로
 * 대조도 생성기로 합니다: `npm run db:prisma:build` 를 돌린 결과와 디스크가 같아야 합니다.
 */
describe('prisma/migrations', () => {
  const items = plan();

  it('db/ 의 적용 순서를 그대로 옮긴다 — 스키마 그룹 → 마이그레이션', () => {
    expect(ORDERED_FILES).toEqual([...SCHEMA_FILES, ...MIGRATION_FILES]);
    expect(items).toHaveLength(SCHEMA_FILES.length + MIGRATION_FILES.length);
  });

  /**
   * 뷰는 마이그레이션이 아닙니다. 넣으면 (1) 항상 마지막이어야 하는 뷰 폴더의 이름이
   * 새 마이그레이션마다 밀려 이미 적용된 DB 와 어긋나고 (2) 집계식 한 줄 고치는 데
   * 새 파일이 필요해집니다. 기동 시 적용(lib/prisma.ts bootChecks)과 `npm run db:views` 로 갑니다.
   */
  it('뷰는 마이그레이션에 들어가지 않는다', () => {
    expect(ORDERED_FILES).not.toContain(DERIVED_SQL_FILE);
    expect(items.map((m) => m.folder).filter((f) => f.endsWith('_views'))).toEqual([]);
  });

  /**
   * 폴더 이름이 순번이라, 목록 중간에 파일을 끼워 넣으면 그 뒤 이름이 전부 밀립니다.
   * 이미 적용된 DB 에서는 "없던 마이그레이션이 생겼다" 로 보이므로 앞자리를 고정해 둡니다.
   */
  it('앞자리 폴더 이름이 고정돼 있다 — 목록은 덧붙이기만 한다', () => {
    const byFile = new Map(items.map((m) => [m.file, m.folder]));
    expect(byFile.get('schema.sql')).toBe('20260101000000_schema');
    expect(byFile.get('migrate-001-machine-list.sql')).toBe('20260101000900_migrate_001_machine_list');
    expect(byFile.get('migrate-079-ez2dj-aeic-ae-remix-charts.sql')).toBe(
      '20260101012700_migrate_079_ez2dj_aeic_ae_remix_charts',
    );
  });

  it('폴더 이름이 사전순으로 적용 순서와 같다 — Prisma 는 이름순으로 적용한다', () => {
    const folders = items.map((m) => m.folder);
    expect([...folders].sort()).toEqual(folders);
  });

  it('디스크의 마이그레이션이 db/ 에서 생성한 것과 같다', () => {
    const missing: string[] = [];
    const differs: string[] = [];
    for (const m of items) {
      const file = path.join(MIGRATIONS_DIR, m.folder, 'migration.sql');
      if (!fs.existsSync(file)) missing.push(m.folder);
      else if (fs.readFileSync(file, 'utf8') !== m.sql) differs.push(m.folder);
    }
    // 어긋났다면 `npm run db:prisma:build` 로 다시 생성하라는 뜻입니다.
    expect({ missing, differs }).toEqual({ missing: [], differs: [] });
  });

  it('목록에 없는 마이그레이션 폴더가 없다', () => {
    const expected = new Set(items.map((m) => m.folder));
    const stale = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !expected.has(e.name))
      .map((e) => e.name);
    expect(stale).toEqual([]);
  });

  it('migration_lock.toml 이 postgresql 로 고정돼 있다', () => {
    expect(fs.readFileSync(path.join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8')).toBe(
      MIGRATION_LOCK,
    );
  });

  /**
   * 스키마 파일 앞머리의 `DROP TABLE IF EXISTS` 는 db:init(파괴적 재생성) 전용입니다.
   * 마이그레이션으로 옮길 때 지워야, 베이스라인을 빠뜨린 DB 에 실수로 deploy 해도
   * 데이터가 조용히 날아가지 않고 "이미 있다" 로 멈춥니다.
   */
  it('스키마 파일의 db:init 전용 DROP 은 주석 처리된다', () => {
    const schemaMigrations = items.filter((m) => SCHEMA_FILES.includes(m.file));
    for (const m of schemaMigrations) {
      expect(m.sql).not.toMatch(/^[ \t]*DROP[ \t]+TABLE[ \t]+IF[ \t]+EXISTS/im);
    }
    // 원본에는 있었다는 것도 같이 고정한다 — 원본이 바뀌어 규칙이 무의미해지면 알아야 한다.
    const schemaSql = fs.readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8');
    expect(schemaSql).toMatch(/DROP TABLE IF EXISTS/);
    expect(stripInitDrops(schemaSql)).toContain('[prisma-migrations-build] db:init 전용');
  });

  /**
   * migrate-*.sql 의 DROP 은 그 파일이 만든 임시 테이블을 치우는 것이라 남아야 합니다.
   * (예: migrate-078 의 `DROP TABLE ez2dj_aeic_charts;`)
   */
  it('migrate-*.sql 의 임시 테이블 DROP 은 그대로 남는다', () => {
    const m = items.find((x) => x.file === 'migrate-078-ez2dj-aeic-tier.sql');
    expect(m?.sql).toMatch(/DROP TABLE ez2dj_aeic_charts;/);
  });
});
