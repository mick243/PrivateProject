import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
// 확장자를 붙입니다 — scripts/ 의 .ts 도구가 번들러 없이 Node 로 이 파일을 직접 import 합니다.
import { Prisma, PrismaClient } from './generated/prisma/client.ts';
import { fingerprint, recordOperation } from './telemetry.ts';

/**
 * 앱의 **유일한** DB 진입점 — Prisma Client.
 *
 * 2026-09-22 에 `lib/*.ts` 의 원시 SQL 121개를 전부 여기로 옮겼습니다. 옮긴 뒤의 모양은
 * 두 가지입니다.
 *   · 단일 표 CRUD · 관계 조인 · 집계          → Prisma Client API (모듈마다 직접)
 *   · 측정 근거가 있는 튜닝 SQL · DB 안의 원자적 연산 → `prisma/sql/*.sql` (TypedSQL —
 *     `prisma generate --sql` 이 타입을 만들고, 그 모듈을 `lib/typed-sql/` 로 꺼내 커밋해
 *     `$queryRawTyped` 로 부릅니다 — scripts/prisma-typed-sql.mjs 머리말)
 * 어느 쪽이든 **TS 코드 안에 SQL 문자열은 없습니다.** 무엇을 어느 쪽으로 보냈고 왜인지는
 * docs/PRISMA-MIGRATION.md §6.
 *
 * scripts/ 의 .ts 도구(오락실·채보 수입, 좌표 갱신, 데이터 릴리스)도 2026-09-28 부터 이 파일을
 * 씁니다. 그 전까지 도구들이 쓰던 `lib/db.ts`(node-postgres 직결 · PGlite 폴백 · 기동 시
 * 마이그레이션)는 쓰는 곳이 없어져 지웠습니다(main 반영 2026-10-08). 원시 SQL 이 남은 곳은
 * 스키마를 다루는 러너(migrate.mjs · init-db.mjs · prisma-baseline.mjs)와 `.mjs` 관리 도구들입니다 —
 * 목록과 이유는 docs/DATA-SOURCES.md §5.
 *
 * ⚠ 이 경로에는 **PGlite 폴백이 없습니다.** Prisma 7 의 공식 드라이버 어댑터에 PGlite 용이
 *   없습니다 — DATABASE_URL 이 필수이고, PostgreSQL 에 못 붙으면 그 자리에서 실패합니다.
 *   "노트북에서 Postgres 를 꺼 둔 채 화면만 보기" 는 이제 되지 않습니다.
 */

/**
 * 쿼리 계측 (lib/telemetry.ts). 원시 SQL 시절에는 `Db` 어댑터를 한 겹 감쌌고, Prisma 에서는
 * 클라이언트 확장(`$extends`)으로 모든 연산을 지납니다. PULSE 설정도 METRICS_TOKEN 도 없으면
 * recordOperation 이 즉시 반환하므로 남는 비용은 performance.now() 두 번입니다.
 *
 * 지문: Prisma Client 연산은 `<연산> <모델>`(예: `findMany posts`), TypedSQL 은 그 SQL 의
 * 지문(`SELECT arcades`) — 원시 SQL 시절의 `query.<VERB 테이블>` 지표와 이어집니다.
 */
function withTelemetry(base: PrismaClient) {
  return base.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        const sql = (args as { sql?: unknown } | undefined)?.sql;
        const key = model ? `${operation} ${model}` : typeof sql === 'string' ? fingerprint(sql) : operation;
        const t0 = performance.now();
        try {
          const result = await query(args);
          recordOperation(key, performance.now() - t0, true);
          return result;
        } catch (err) {
          recordOperation(key, performance.now() - t0, false);
          throw err;
        }
      },
    },
  });
}

/** 앱이 쓰는 클라이언트 타입 — 계측 확장이 붙은 PrismaClient */
export type AppPrismaClient = ReturnType<typeof withTelemetry>;

const globalForPrisma = globalThis as unknown as {
  __prismaPool?: import('pg').Pool;
  /** 값이 아니라 **약속**을 담습니다 — 동시에 100 요청이 와도 초기화는 한 번입니다. */
  __prisma?: Promise<AppPrismaClient>;
};

/**
 * 인터랙티브 트랜잭션의 제한 시간.
 *
 * Prisma 의 기본값은 maxWait 2초 · timeout 5초라서 node-postgres 직결(제한 없음)보다
 * **짧습니다**. 부하가 몰려 풀 슬롯을 기다리는 동안 트랜잭션이 통째로 취소되면 예전에는
 * 없던 실패가 생기므로 넉넉하게 잡고, 환경변수로 열어 둡니다.
 */
export const TX_OPTIONS = {
  timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS) || 15_000,
  maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS) || 5_000,
} as const;

/**
 * scripts/ 의 일괄 작업(오락실·채보 수입, 병합, 좌표 갱신, 데이터 릴리스)용 제한 시간.
 *
 * TX_OPTIONS 의 15초는 요청 하나를 기준으로 잡은 값입니다. 채보 6,000개를 한 트랜잭션에
 * 넣는 도구에는 짧습니다 — 옛 경로(node-postgres 직결)에는 제한이 아예 없었습니다.
 * 도구는 사람이 지켜보며 돌리므로 10분으로 둡니다. 앱 코드에서는 쓰지 마세요.
 */
export const BULK_TX_OPTIONS = {
  timeout: Number(process.env.PRISMA_BULK_TX_TIMEOUT_MS) || 600_000,
  maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS) || 5_000,
} as const;

/**
 * 마이그레이션·뷰 적용 잠금 키. `scripts/db-files.mjs`(→ migrate.mjs · init-db.mjs)와
 * **같은 값**이어야 합니다 — 옛 러너와 이 경로의 서버가 같은 순간에 떠도 서로 기다리게.
 */
const MIGRATION_LOCK_KEY = 72_028_531;

/**
 * 커넥션 풀. **우리가 만들어서** 어댑터에 넘깁니다.
 *
 *   1. 풀 설정(PG_POOL_MAX)이 옛 경로와 같아야 합니다 — 근거는 PERFORMANCE.md 에 측정으로
 *      남아 있고, 엔진을 바꿨다고 그 값이 달라지지 않습니다.
 *   2. 뷰 적용처럼 여러 스테이트먼트가 든 SQL 파일은 Prisma 로 보낼 수 없어 풀을 직접 씁니다.
 *
 * ⚠ `timezone=UTC` 는 장식이 아니라 **정확성** 문제입니다. 드라이버 어댑터를 통한
 *   `$queryRaw` 계열은 timestamptz 를 세션 시간대의 벽시계로 읽어 UTC 라고 이름 붙입니다.
 *   세션이 Asia/Seoul 이면 모든 시각이 **+9시간** 어긋납니다 (2026-09-22 실측:
 *   pg 08:15:13Z / prisma 17:15:13Z, epoch 차이 32400초). 세션을 UTC 로 고정하면 0 이 됩니다.
 *   코드베이스에 date_trunc·to_char·::date 같은 세션 시간대에 의존하는 SQL 이 없어
 *   (2026-09-22 확인) UTC 고정의 부작용도 없습니다.
 */
async function createPool(connectionString: string): Promise<import('pg').Pool> {
  const { default: pg } = await import('pg');
  const max = Number(process.env.PG_POOL_MAX) || 30;
  const pool = new pg.Pool({ connectionString, max, options: '-c timezone=UTC' });
  // 유휴 커넥션 오류를 받아 주지 않으면 프로세스가 죽습니다 (pg.Pool 은 'error' 를 그대로 던집니다).
  pool.on('error', (err) => console.error('[prisma] 유휴 커넥션 오류 —', err.message));
  return pool;
}

/** `prisma/migrations/` 의 폴더 이름 = 적용되어야 할 마이그레이션 목록 */
export function migrationNames(): readonly string[] {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** prisma/migrations 중 이 DB 에 아직 적용되지 않은 것. `_prisma_migrations` 가 없으면(베이스라인 전) 전부 */
async function listPending(pool: import('pg').Pool): Promise<string[]> {
  const expected = migrationNames();
  if (!expected.length) return [];
  let applied = new Set<string>();
  try {
    const { rows } = await pool.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    applied = new Set(rows.map((r) => r.migration_name));
  } catch {
    // 테이블 자체가 없으면 베이스라인 전입니다 — 전부 미적용으로 봅니다.
  }
  return expected.filter((name) => !applied.has(name));
}

/**
 * 기동 점검 두 가지. 실패하면 클라이언트를 돌려주지 않습니다.
 *
 * 1. **마이그레이션은 적용하지 않고 경고만** — 적용은 배포 단계의 `prisma migrate deploy` 가
 *    합니다. 옛 경로는 서버가 뜨면서 빠진 것을 직접 넣었지만(지금은 지운 lib/db.ts), Prisma 의
 *    설계는 "배포가 먼저, 기동은 그다음" 입니다. 조용히 도는 것이 제일 나쁘므로 시끄럽게 찍습니다.
 * 2. **뷰는 기동마다 다시 만듭니다** — 마이그레이션이 아니라서(scripts/prisma-migrations-build.mjs
 *    의 ORDERED_FILES 주석) 옛 경로와 같은 방식으로 `db/views.sql` 을 적용합니다. 데이터가 없는
 *    파생 객체라 몇 번을 다시 만들어도 안전하고, 인스턴스 둘이 동시에 떠도 advisory lock 으로
 *    한 번에 하나만 들어갑니다.
 */
async function bootChecks(pool: import('pg').Pool): Promise<void> {
  const pending = await listPending(pool);
  if (pending.length) {
    console.warn(
      `[prisma] 마이그레이션 ${pending.length}개가 적용되지 않았습니다 — 첫 번째: ${pending[0]}\n` +
        `         기동하면서 적용하지 않습니다. \`npm run db:prisma:baseline\`(기존 DB) 또는 ` +
        `\`npm run db:migrate:prisma\` 를 먼저 돌리세요.`,
    );
  }

  const views = fs.readFileSync(path.join(process.cwd(), 'db', 'views.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(views);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function createClient(): Promise<AppPrismaClient> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL 이 없습니다. 앱은 PostgreSQL 에만 붙습니다 — Prisma 에는 PGlite 어댑터가 없습니다 (lib/prisma.ts).',
    );
  }

  const pool = (globalForPrisma.__prismaPool ??= await createPool(connectionString));
  await bootChecks(pool);

  const adapter = new PrismaPg(pool, {
    // 풀의 주인은 우리입니다 — 클라이언트를 $disconnect 해도 풀을 닫으면 안 됩니다.
    disposeExternalPool: false,
    onPoolError: (err) => console.error('[prisma] 풀 오류 —', err.message),
  });
  const prisma = withTelemetry(new PrismaClient({ adapter }));
  console.log('[prisma] PostgreSQL 에 붙었습니다 — 뷰 적용 완료');
  return prisma;
}

/**
 * 앱 전역에서 쓰는 Prisma 클라이언트.
 *
 * dev 서버 HMR 로 이 모듈이 다시 평가돼도 풀이 새로 뜨지 않도록 globalThis 에 캐시합니다.
 * 실패한 약속은 캐시에서 지웁니다 — 남기면 프로세스가 사는 동안 같은 에러만 돌려줍니다.
 */
export function getPrismaClient(): Promise<AppPrismaClient> {
  globalForPrisma.__prisma ??= createClient().catch((err: unknown) => {
    globalForPrisma.__prisma = undefined;
    throw err;
  });
  return globalForPrisma.__prisma;
}

/**
 * 붙어 있는 DB 에 아직 적용되지 않은 마이그레이션 (기동 경고와 같은 계산).
 * 데이터를 넣는 도구(scripts/data-release.ts)가 "스키마가 이 저장소와 같은가" 를 먼저 봅니다 —
 * 새 컬럼이 없는 DB 에 넣으면 도중에 실패하거나, 더 나쁘게는 절반만 들어갑니다.
 */
export async function pendingMigrations(): Promise<string[]> {
  await getPrismaClient();
  return listPending(globalForPrisma.__prismaPool!);
}

/**
 * 트랜잭션 콜백이 받는 클라이언트 — 모듈들이 `tx` 파라미터의 타입으로 씁니다.
 * `Prisma.TransactionClient` 가 아니라 **계측 확장이 붙은** 클라이언트에서 뺀 것입니다 —
 * `$extends` 를 거친 클라이언트의 `$transaction` 은 확장된 자기 타입을 콜백에 넘깁니다.
 */
export type PrismaTx = Omit<
  AppPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Decimal(numeric) · 숫자 · 문자열을 number 로. NULL 은 그대로 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v instanceof Prisma.Decimal ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
}

/** Date 는 ISO 로, 그 외(json_agg 안의 문자열 등)는 다시 파싱해 ISO 로 */
export function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}
