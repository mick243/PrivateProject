import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI 설정 (Prisma 7).
 *
 * 7 부터 `schema.prisma` 의 `datasource.url` 이 없어졌습니다 — 연결 문자열은 이 파일에서
 * CLI 에게, 런타임에는 드라이버 어댑터(lib/prisma.ts)로 따로 줍니다.
 *
 * ⚠ Prisma 7 은 `.env` 를 스스로 읽지 않습니다. 이 프로젝트의 정본은 `.env.local` 이라
 *   (scripts/migrate.mjs · init-db.mjs 와 같은 자리) 여기서 최소 파서로 직접 읽습니다.
 *   dotenv 를 의존성으로 들이지 않는 것도 그 스크립트들과 같은 판단입니다.
 */
function loadEnvLocal(): void {
  const file = path.join(import.meta.dirname, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    // 이미 들어와 있는 환경변수가 이깁니다 — CI·일회성 실행에서 앞에 붙여 줄 수 있어야 합니다.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  experimental: {
    // 아래 tables.external 을 쓰려면 켜야 합니다.
    externalTables: true,
  },
  tables: {
    /**
     * 옛 마이그레이션 러너(scripts/migrate.mjs · lib/db.ts)가 쓰는 이력 테이블입니다.
     * Prisma 의 데이터모델에는 없지만 DB 에는 남아 있어야 합니다 — 앱 코드를 git 으로 되돌리면
     * 옛 러너가 이 표를 보고 그대로 돌 수 있게 남겨 두는 것이 이관 계획입니다
     * (docs/PRISMA-MIGRATION.md §3-3 되돌리기).
     *
     * 여기 적어 두지 않으면 `migrate diff`(= npm run db:prisma:drift)가 매번
     * "schema_migrations 를 지워야 한다" 고 말합니다. 잡음이 섞인 드리프트 검사는
     * 아무도 보지 않게 되므로, 의도적으로 남기는 것은 의도적으로 제외합니다.
     */
    external: ['public.schema_migrations'],
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    /**
     * 섀도 DB. `migrate dev` 와 `migrate diff --from-migrations` 가 마이그레이션을
     * **빈 DB 에 처음부터 적용해 보는** 곳입니다. 기본값(자동 생성)은 CREATE DATABASE
     * 권한이 필요하고 개발 DB 옆에 임시 DB 를 만듭니다. 그게 싫으면
     * SHADOW_DATABASE_URL 로 빈 DB 를 직접 지정하세요.
     *
     * ⚠ 섀도 DB 는 매번 비워집니다. 절대 개발·운영 DB 를 가리키지 마세요.
     */
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
