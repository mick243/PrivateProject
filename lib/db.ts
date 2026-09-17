import fs from 'node:fs';
import path from 'node:path';
// 확장자를 붙인다 — scripts/ 의 .ts 도구들이 이 파일을 **번들러 없이** Node 로 바로
// 실행하는데, ESM 은 확장자 없는 상대 경로를 해석하지 못한다. tsconfig 가
// allowImportingTsExtensions 라 앱 빌드 쪽은 그대로다.
// (이게 없어서 npm run arcades:import 가 ERR_MODULE_NOT_FOUND 로 죽고 있었다.)
import { recordPoolQuery, withTelemetry } from './telemetry.ts';

/**
 * DB 어댑터.
 *
 *  - DATABASE_URL 이 있으면        → 실제 PostgreSQL (node-postgres)
 *  - 없으면                        → PGlite (WASM 로 빌드된 내장 Postgres, .pglite/ 에 영속)
 *  - 있는데 **연결이 안 되면**     → PGlite 로 내려갑니다 (DB_FALLBACK=off 로 끌 수 있음)
 *
 * 양쪽 다 진짜 Postgres 엔진이라 SQL 은 한 글자도 바뀌지 않습니다.
 * 프로토타입은 설치 없이 돌리고, 운영은 연결 문자열만 채우면 됩니다.
 *
 * 폴백은 PostgreSQL 서비스가 멈춰 있어도(재시작 중, 노트북에서 서비스를 꺼 둔 상태)
 * 화면이 그대로 뜨게 하려는 것입니다. `.pglite/` 는 `npm run db:snapshot -- --yes` 로
 * 떠 두는 **PostgreSQL 의 사본**이고, 폴백으로 내려간 동안 쓴 내용은 사본에만 남습니다
 * (createDbWithFallback 주석 참고).
 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** 다중 스테이트먼트 SQL 실행 (마이그레이션용) */
  exec(sql: string): Promise<void>;
  /** 단일 커넥션 위에서 BEGIN/COMMIT 을 보장 */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** 지금 어느 엔진으로 돌고 있는지 */
export type DbDriver = 'postgres' | 'pglite';

export interface DbStatus {
  driver: DbDriver;
  /** PostgreSQL 을 쓰려 했는데 못 붙어서 내려온 이유 (내려온 적이 없으면 없음) */
  fallbackReason?: string;
  /** 내려온 시각 (ISO) */
  fallbackAt?: string;
}

const globalForDb = globalThis as unknown as {
  __db?: Promise<Db>;
  __dbStatus?: DbStatus;
};

/**
 * 지금 실제로 쓰이는 엔진. PGlite 로 내려갔다면 그 이유가 같이 담깁니다.
 *
 * dev 서버 HMR 로 이 모듈이 다시 평가돼도 값이 남아야 해서 globalThis 에 둡니다 —
 * 커넥션(`__db`)이 그렇게 캐시되므로 상태도 같은 자리에 있어야 짝이 맞습니다.
 */
export function getDbStatus(): DbStatus {
  return globalForDb.__dbStatus ?? { driver: process.env.DATABASE_URL ? 'postgres' : 'pglite' };
}

function setStatus(status: DbStatus): void {
  globalForDb.__dbStatus = status;
}

/** 폴백으로 내려갈 때 소켓을 정리하려고 pg 어댑터만 close 를 더 갖습니다. */
interface PgDb extends Db {
  close(): Promise<void>;
  /** 스키마·마이그레이션·뷰 적용 (advisory lock 안에서). 연결이 확인된 뒤 한 번 부릅니다 */
  applySchema(): Promise<void>;
}

async function createPgDb(connectionString: string): Promise<PgDb> {
  const { default: pg } = await import('pg');
  /**
   * 커넥션 상한.
   *
   * node-postgres 기본값은 10 인데, 부하테스트에서 그게 병목이었다 — 부하 중
   * `pg_stat_activity` 를 보면 커넥션이 **정확히 상한에 붙어** 있었고 정작 DB 는
   * 한가했다. 요청은 Node 안에서 슬롯이 나기를 기다리고 있었던 것이다.
   *
   * 30 은 측정으로 고른 값이다 (200 VU 기준, 각 두 번씩):
   *   10 → 263 req/s · p95 1.93s
   *   30 → 372·384 req/s · p95 900·849ms   (편차 3.2%)
   *   50 → 337·415 req/s                   (편차 20.5%)
   * 50 은 평균 처리량이 30 과 같은데 실행마다 출렁인다. 커넥션을 더 열수록
   * Postgres 안에서 경합이 늘기 때문이다. 같은 성능이면 흔들리지 않는 쪽이 낫고,
   * `max_connections = 100` 아래 여유도 더 남는다 (인스턴스를 늘릴 여지).
   *
   * 인스턴스를 여러 개 띄우면 이 값 × 인스턴스 수가 `max_connections` 를 넘지
   * 않는지 확인할 것. 자세한 근거는 PERFORMANCE.md.
   */
  const max = Number(process.env.PG_POOL_MAX) || 30;
  const pool = new pg.Pool({ connectionString, max });

  /**
   * 스키마·마이그레이션·뷰를 **여기서도** 적용합니다.
   *
   * 2026-09-13 까지는 PGlite 경로(createPgliteDb)만 이걸 했고 PostgreSQL 은 풀만
   * 만들었습니다. 그래서 운영 DB 에 새 마이그레이션을 넣는 유일한 코드 경로가
   * `db:init`(테이블을 DROP 하는 파괴적 스크립트)이었고, 개발 DB 의 052·053 은
   * 누군가 psql 로 손수 넣은 것이었습니다. 문서(GUIDELINES §3)는 부팅 시 적용되는
   * 것처럼 적혀 있어 코드와 어긋났습니다.
   *
   * 인스턴스 2개가 같은 순간에 뜨면 둘이 같은 마이그레이션을 동시에 시도합니다.
   * `pg_advisory_lock` 으로 한 번에 한 프로세스만 들어가게 하고, 잠금을 얻은 쪽은
   * `schema_migrations` 를 **다시 읽어** 앞사람이 끝낸 것을 건너뜁니다.
   *
   * 여기서 난 오류는 폴백 대상이 아닙니다 — "DB 에 못 닿았다" 가 아니라 "SQL 이
   * 틀렸다" 이고, 그걸 로컬 사본에서 다시 시도하면 버그가 조용히 묻힙니다.
   * createDbWithFallback 이 probe/createPgDb 를 try 로 감싸므로, 스키마 적용은
   * 그 밖(applyPgSchema)에서 따로 부릅니다.
   */
  const applyPgSchema = async (): Promise<void> => {
    const client = await pool.connect();
    const one: Db = {
      async query(text, params) {
        const res = await client.query(text, params as never[]);
        return { rows: res.rows };
      },
      async exec(sql) {
        await client.query(sql);
      },
      async transaction(fn) {
        await client.query('BEGIN');
        try {
          const result = await fn(one);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      },
    };
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await applySchema(one, 'PostgreSQL');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  };

  /**
   * **유휴 커넥션의 에러를 받아 주지 않으면 프로세스가 죽습니다.**
   *
   * node-postgres 의 Pool 은 쉬고 있는 클라이언트가 끊길 때 'error' 를 emit 하는데,
   * EventEmitter 라서 리스너가 없으면 uncaught exception 이 됩니다. PostgreSQL 을
   * 재시작하면 풀에 있던 커넥션이 한꺼번에 끊기므로, 이 리스너가 없으면 요청을
   * 처리하던 중이 아니어도 dev 서버가 그 자리에서 내려갑니다.
   */
  pool.on('error', (err) => {
    console.error('[db] 유휴 커넥션 오류 —', err.message);
  });

  return {
    /**
     * pool.query 한 방으로 끝내지 않고 connect → query → release 로 펼쳐 둔 이유는
     * **시간을 쪼개서 재기 위해서** 다. pool.query 는 슬롯 대기와 실행을 한 덩어리로
     * 돌려주는데, 그러면 지표에서 "DB 가 느리다" 와 "슬롯이 없다" 를 가를 수 없다.
     * 동작은 동일하다 — pool.query 자체가 이 셋을 묶어 놓은 것이고, 실패해도
     * finally 에서 반납한다.
     *
     * 계측이 꺼져 있으면 recordPoolQuery 는 즉시 반환하므로 남는 비용은
     * performance.now() 두 번이다.
     */
    async query(text, params) {
      const t0 = performance.now();
      const client = await pool.connect();
      const t1 = performance.now();
      try {
        const res = await client.query(text, params as never[]);
        recordPoolQuery(text, t1 - t0, performance.now() - t1);
        return { rows: res.rows };
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query(text, params) {
            const res = await client.query(text, params as never[]);
            return { rows: res.rows };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
    applySchema: applyPgSchema,
  };
}

/**
 * 마이그레이션 잠금 키. 같은 DB 를 보는 모든 프로세스가 같은 값을 써야 합니다
 * (`scripts/migrate.mjs` 도 이 값입니다). 의미 없는 상수 — 겹치지 않을 만한 수.
 */
export const MIGRATION_LOCK_KEY = 72_028_531;

/**
 * 스키마 그룹 → 마이그레이션 → 뷰 순서로 적용합니다. PGlite 와 PostgreSQL 이
 * 같은 함수를 씁니다 — 둘이 다른 코드를 타면 한쪽에만 빠진 파일이 생깁니다.
 */
async function applySchema(db: Db, label: string): Promise<void> {
  // 필요한 부분만 자동 적용. 기능이 추가되기 전에 만들어진 DB 도
  // 여기서 따라잡히므로, 스키마가 늘어날 때마다 db:reset 을 강요하지 않는다.
  const applied: string[] = [];
  for (const group of SQL_GROUPS) {
    const { rows } = await db.query<{ exists: string | null }>(
      `SELECT to_regclass($1)::text AS exists`,
      [`public.${group.sentinel}`],
    );
    if (rows[0]?.exists) continue;
    for (const file of group.files) await db.exec(readSql(file));
    applied.push(...group.files);
  }
  if (applied.length) console.log(`[db] ${label} 스키마 적용 — ${applied.join(', ')}`);

  await runMigrations(db);

  // 뷰는 sentinel 과 무관하게 항상 다시 만든다. 위 루프는 "없으면 만든다" 라서
  // 이미 적용된 그룹의 정의가 바뀌어도 따라잡지 못하는데, 뷰는 데이터를 갖지 않아
  // 매번 DROP → CREATE 해도 안전하다. 집계식을 고치면 서버 재시작으로 반영된다.
  await db.exec(readSql(DERIVED_SQL_FILE));
}

async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite(path.join(process.cwd(), '.pglite'));
  await pglite.waitReady;

  const db: Db = {
    async query(text, params) {
      const res = await pglite.query(text, params as unknown[]);
      return { rows: res.rows as never[] };
    },
    async exec(sql) {
      await pglite.exec(sql);
    },
    async transaction(fn) {
      return pglite.transaction(async (tx) =>
        fn({
          async query(text, params) {
            const res = await tx.query(text, params as unknown[]);
            return { rows: res.rows as never[] };
          },
        }),
      ) as Promise<never>;
    },
  };

  // PGlite 는 한 프로세스만 열 수 있어 잠금이 필요 없다.
  await applySchema(db, 'PGlite');

  return db;
}

/**
 * 이미 적용된 스키마를 **고치는** 변경을 따라잡습니다.
 *
 * 스키마 그룹(SQL_GROUPS)은 sentinel 테이블이 없을 때만 적용되므로 "새 기능 추가"
 * 밖에 못 합니다. 기종 목록을 손보는 것처럼 기존 데이터를 고치는 변경은
 *   - 그룹에 넣으면  → 기존 DB 는 영원히 못 받고
 *   - sentinel 을 바꾸면 → 그룹 전체가 재적용돼 사용자가 쓴 글이 지워집니다
 * 그래서 적용 이력을 테이블에 남기고 한 번씩만 실행합니다.
 *
 * 각 파일은 **여러 번 실행해도 안전하게** 씁니다 (DELETE / ADD COLUMN IF NOT EXISTS /
 * INSERT ... ON CONFLICT DO NOTHING). 새로 만든 DB 는 시드에 이미 최종 상태가 들어
 * 있으므로 마이그레이션이 아무 일도 하지 않고 이력만 남깁니다.
 */
async function runMigrations(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));

  for (const file of MIGRATION_FILES) {
    if (applied.has(file)) continue;
    // 파일 적용과 이력 기록을 한 트랜잭션으로 — 중간에 실패하면 둘 다 없어야 한다.
    // (exec 은 여러 스테이트먼트를 받으므로 BEGIN/COMMIT 을 같이 넣는다.)
    await db.exec(`BEGIN;
${readSql(file)}
INSERT INTO schema_migrations (name) VALUES ('${file}');
COMMIT;`);
    console.log(`[db] 마이그레이션 적용 — ${file}`);
  }
}

/**
 * 적용 순서 고정 — tier 스키마가 machines 를 참조하므로 오락실이 먼저다.
 * sentinel 은 그 그룹이 이미 적용됐는지 판별하는 대표 테이블.
 */
export const SQL_GROUPS = [
  { sentinel: 'arcades', files: ['schema.sql', 'seed.sql'] },
  { sentinel: 'charts', files: ['schema-tier.sql', 'seed-tier.sql'] },
  // sentinel 은 그룹에서 가장 마지막에 만들어지는 테이블이어야 한다.
  // 기능이 추가돼 파일이 바뀌면 새 테이블을 sentinel 로 삼아 재적용을 유도한다.
  //
  // 제보/리뷰/평가는 arcades(오락실) 와 players/charts(서열표) 를 모두 참조하므로 뒤에.
  { sentinel: 'chart_comments', files: ['schema-community.sql', 'seed-community.sql'] },
  { sentinel: 'post_likes', files: ['schema-board.sql', 'seed-board.sql'] },
  // 게시판에 나중에 추가된 기능. 위 그룹에 넣으면 sentinel 이 이미 있어서 적용되지
  // 않고, sentinel 을 바꾸면 그룹 전체가 재적용돼 이미 쓴 글이 지워진다.
  { sentinel: 'post_images', files: ['schema-board-images.sql'] },
] as const;

/**
 * 데이터를 갖지 않는 파생 객체(뷰). 위 그룹들과 달리 **매번 다시 적용**된다.
 * sentinel 방식은 새 그룹만 추가할 수 있어서, 이미 적용된 집계식을 고치려면
 * db:reset 을 해야 했다. 뷰만 따로 빼서 그 함정을 없앤다.
 */
export const DERIVED_SQL_FILE = 'views.sql';

/**
 * 이미 적용된 스키마·시드를 고치는 변경. 순서대로 한 번씩만 실행되고
 * `schema_migrations` 에 이력이 남습니다 (runMigrations 주석 참고).
 * 파일은 여러 번 실행해도 결과가 같도록 씁니다.
 */
export const MIGRATION_FILES = [
  'migrate-001-machine-list.sql',
  'migrate-002-cabinets.sql',
  'migrate-003-queue-ttl.sql',
  'migrate-004-admin.sql',
  'migrate-005-piu-songs.sql',
  'migrate-006-piu-pro2-m.sql',
  'migrate-007-piu-artists.sql',
  'migrate-008-oauth-identities.sql',
  'migrate-009-arcade-source.sql',
  'migrate-010-strip-corporate-form.sql',
  'migrate-011-queue-ttl-4h.sql',
  'migrate-012-piu-s1-tier.sql',
  'migrate-013-drop-seed-piu-tiers.sql',
  'migrate-014-tier-scale-rework.sql',
  'migrate-015-notice-category.sql',
  'migrate-016-post-body-doc.sql',
  'migrate-017-arcade-favorites.sql',
  'migrate-018-piu-s2-tier.sql',
  'migrate-019-piu-remix-shortcut-fullsong.sql',
  'migrate-020-restore-saranga-chart.sql',
  'migrate-021-piu-remix-text-list.sql',
  'migrate-022-drop-novasonic-novarash-remix.sql',
  'migrate-023-drop-remix-subset.sql',
  'migrate-024-drop-remix-subset-2.sql',
  'migrate-025-drop-remix-subset-3.sql',
  'migrate-026-oauth-nickname.sql',
  'migrate-027-nickname-ci-unique.sql',
  'migrate-028-piu-s3-tier.sql',
  'migrate-029-fix-s3-final-audition.sql',
  'migrate-030-piu-s4-tier.sql',
  'migrate-031-piu-s5-tier.sql',
  'migrate-032-piu-s6-tier.sql',
  'migrate-033-piu-all-charts.sql',
  'migrate-034-vote-scale-0.1.sql',
  'migrate-035-grade-band-tiebreak.sql',
  'migrate-036-chart-tag-rework.sql',
  'migrate-037-notice-without-game.sql',
  'migrate-038-add-machines.sql',
  'migrate-039-condition-window-30d.sql',
  'migrate-040-chart-special-flag.sql',
  'migrate-041-special-marks-consensus.sql',
  'migrate-042-posts-scale-indexes.sql',
  'migrate-043-sdvx-8-tier.sql',
  'migrate-044-tier-chart-basis.sql',
  'migrate-045-mode-is-difficulty.sql',
  'migrate-046-sdvx-chart-tags.sql',
  'migrate-047-sdvx-17-tier.sql',
  'migrate-048-drop-sdvx-17-off-sheet.sql',
  'migrate-049-verse-iv-a-tier.sql',
  'migrate-050-player-email.sql',
  'migrate-051-email-verification.sql',
  'migrate-052-login-failures.sql',
  'migrate-053-queue-purge-index.sql',
  'migrate-054-rate-counters.sql',
  'migrate-055-arcade-homepage.sql',
  'migrate-056-fk-player-indexes.sql',
  'migrate-057-token-epoch.sql',
  'migrate-058-chart-level-notation.sql',
  'migrate-059-ez2dj-6th-trax-tier.sql',
  'migrate-060-ez2dj-7th-trax-tier.sql',
  'migrate-061-machine-guesses.sql',
  'migrate-062-emoticons.sql',
  'migrate-063-imported-news.sql',
  'migrate-064-emoticons-soft-delete.sql',
  'migrate-065-chart-video.sql',
  'migrate-066-chart-video-piu-s4.sql',
  'migrate-067-chart-video-piu-s1-s3.sql',
  'migrate-068-chart-video-nakaka-s19.sql',
  'migrate-069-chart-video-86-s20.sql',
  'migrate-070-chart-video-piu-s4-rest.sql',
  'migrate-071-chart-video-piu-s4-others.sql',
  'migrate-072-chart-video-piu-s4-manual.sql',
  'migrate-073-review-summaries.sql',
] as const;

export const SQL_FILES = [
  ...SQL_GROUPS.flatMap((g) => g.files),
  ...MIGRATION_FILES,
  DERIVED_SQL_FILE,
];

export function readSql(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'db', file), 'utf8');
}

/**
 * 폴백 스위치.
 *
 *   DB_FALLBACK=off  → 연결이 안 되면 그냥 에러를 냅니다
 *   DB_FALLBACK=on   → 연결이 안 되면 .pglite/ 사본으로 내려갑니다
 *   (비움)           → **개발에서만 on.** 운영(NODE_ENV=production)은 off 입니다
 *
 * 운영에서 기본을 off 로 둔 이유: 인스턴스 2개가 각자 다른 사본에 글·제보를 쓰면
 * 어느 쪽도 정본이 아닌 상태(스플릿 브레인)가 되고, 사본이 없으면 **시드(가상
 * 오락실 5곳)로 새 DB 를 만들어** 서비스합니다. 노트북에서 Postgres 서비스를
 * 꺼 둔 채 화면을 보는 편의는 운영에 가져갈 것이 아닙니다.
 */
const FALLBACK_ENABLED = process.env.DB_FALLBACK
  ? process.env.DB_FALLBACK !== 'off'
  : process.env.NODE_ENV !== 'production';

/**
 * 첫 연결 확인에 쓰는 제한 시간.
 *
 * 풀(createPgDb)에는 일부러 넣지 않습니다. Pool 의 connectionTimeoutMillis 는 "슬롯이
 * 날 때까지 기다린 시간" 에도 걸리기 때문에, 부하가 몰려 정상적으로 대기하던 요청까지
 * 죽습니다 (200 VU 에서 p95 가 900ms 였습니다 — PERFORMANCE.md). 확인용 커넥션 하나만
 * 따로 열어서 재 봅니다.
 */
const PROBE_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS) || 3000;

/** 소켓 레벨(Node) + 서버가 내려갔거나 아직 못 받는 상태(Postgres) */
const CONNECTION_LOST_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '57P01', // admin_shutdown       — 서비스 정지·재시작
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now   — 부팅 중
]);

/**
 * "DB 에 못 닿았다" 와 "쿼리가 틀렸다" 를 가릅니다. **앞의 것만** 폴백 대상입니다 —
 * 제약 위반이나 문법 오류까지 로컬에서 다시 시도하면 버그가 조용히 묻힙니다.
 *
 * 커넥션이 너무 많다(53300)는 뺐습니다. 그건 DB 가 살아 있다는 뜻이고, 부하가 몰린
 * 순간에 앱 전체가 로컬 사본으로 굴러떨어지는 게 훨씬 나쁩니다.
 */
export function isConnectionLostError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && CONNECTION_LOST_CODES.has(e.code)) return true;
  const message = typeof e?.message === 'string' ? e.message : '';
  return /connection terminated|connection timeout|timeout exceeded when trying to connect|server closed the connection|Client has encountered a connection error|Cannot use a pool after calling end/i.test(
    message,
  );
}

function reasonOf(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return code ? `${message} (${code})` : message;
}

/** 확인용 커넥션 하나로 실제로 붙는지 본다. 풀은 lazy 라서 이걸 안 하면 첫 요청까지 모른다. */
async function probePg(connectionString: string): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: PROBE_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * PostgreSQL 을 먼저 쓰고, 못 닿으면 PGlite(.pglite/)로 내려갑니다.
 *
 * 내려가는 자리는 두 곳입니다.
 *   1. 서버가 뜰 때 — 연결 확인(SELECT 1)이 실패하면 처음부터 PGlite 로 시작
 *   2. 돌던 중에   — 쿼리가 **커넥션 오류**로 실패하면 그 쿼리부터 PGlite 로 다시 실행
 *
 * ⚠ 한 번 내려가면 프로세스가 사는 동안 PostgreSQL 로 돌아가지 않습니다. 살아난 걸
 *   감지해 왕복하면, 내려가 있는 동안 사본에 쌓인 글·제보가 어느 쪽에도 온전히 없는
 *   상태가 됩니다. 어느 쪽이 정본인지 사람이 정해야 하는 문제라 코드가 정하지 않습니다.
 *   PostgreSQL 을 살린 뒤 서버를 재시작하면 다시 붙습니다.
 *
 * ⚠ 그래서 내려간 동안의 **쓰기는 PostgreSQL 에 반영되지 않습니다.** 로그를 시끄럽게
 *   찍는 이유입니다. 운영에서 이 동작이 싫으면 DB_FALLBACK=off 로 끄세요.
 */
async function createDbWithFallback(connectionString: string): Promise<Db> {
  const masked = connectionString.replace(/:[^:@]*@/, ':***@');

  let pgDb: PgDb;
  try {
    await probePg(connectionString);
    pgDb = await createPgDb(connectionString);
  } catch (err) {
    if (!FALLBACK_ENABLED) throw err;
    console.warn(
      `[db] PostgreSQL 연결 실패 — ${reasonOf(err)}\n` +
        `     ${masked}\n` +
        `[db] 로컬 사본(.pglite/)으로 시작합니다 — 여기에 쓴 내용은 PostgreSQL 에 반영되지 않습니다.`,
    );
    setStatus({
      driver: 'pglite',
      fallbackReason: reasonOf(err),
      fallbackAt: new Date().toISOString(),
    });
    return createPgliteDb();
  }

  // 연결은 됐다 — 이제부터의 오류는 SQL 의 문제이므로 폴백하지 않고 그대로 던진다.
  await pgDb.applySchema();

  setStatus({ driver: 'postgres' });
  if (!FALLBACK_ENABLED) return pgDb;

  // 사본은 실제로 내려갈 때 처음 연다 — 안 쓰이면 64MB 짜리 데이터 디렉터리를
  // 붙잡지 않아야 하고, PGlite 는 한 프로세스만 열 수 있어서 더 그렇다.
  let local: Promise<Db> | null = null;
  const localDb = (): Promise<Db> => {
    local ??= createPgliteDb().catch((err: unknown) => {
      local = null; // 실패한 약속을 남기면 다음 요청도 같은 에러다
      throw err;
    });
    return local;
  };

  const failover = (err: unknown): void => {
    if (getDbStatus().driver === 'pglite') return; // 다른 요청이 이미 내렸다
    setStatus({
      driver: 'pglite',
      fallbackReason: reasonOf(err),
      fallbackAt: new Date().toISOString(),
    });
    console.error(
      `[db] PostgreSQL 커넥션이 끊겼습니다 — ${reasonOf(err)}\n` +
        `[db] 로컬 사본(.pglite/)으로 내려갑니다 — 지금부터 쓰는 내용은 PostgreSQL 에 반영되지 않습니다.\n` +
        `[db] PostgreSQL 을 살린 뒤 서버를 재시작해야 다시 붙습니다.`,
    );
    // 끊긴 풀을 열어 두면 재접속을 계속 시도하며 에러만 찍는다.
    void pgDb.close().catch(() => {});
  };

  const run = async <T>(op: (db: Db) => Promise<T>): Promise<T> => {
    if (getDbStatus().driver === 'pglite') return op(await localDb());
    try {
      return await op(pgDb);
    } catch (err) {
      // 내려가는 도중이었다면(다른 요청이 먼저 실패) 이 요청도 사본에서 살린다.
      if (getDbStatus().driver !== 'pglite' && !isConnectionLostError(err)) throw err;
      failover(err);
      return op(await localDb());
    }
  };

  return {
    query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      return run((db) => db.query<T>(text, params));
    },
    exec(sql: string) {
      return run((db) => db.exec(sql));
    },
    transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return run((db) => db.transaction(fn));
    },
  };
}

export function getDb(): Promise<Db> {
  // dev 서버 HMR 마다 커넥션이 새로 뜨지 않도록 globalThis 에 캐시.
  globalForDb.__db ??= (
    process.env.DATABASE_URL
      ? createDbWithFallback(process.env.DATABASE_URL)
      : createPgliteDb()
  )
    // 쿼리 계측(lib/telemetry.ts). PULSE_AGENT_KEY 가 없으면 원본을 그대로 돌려준다.
    .then(withTelemetry)
    .catch((err: unknown) => {
    // 실패한 약속을 캐시에 남기면 프로세스가 사는 동안 같은 에러만 돌려준다.
    globalForDb.__db = undefined;
    throw err;
  });
  return globalForDb.__db;
}
