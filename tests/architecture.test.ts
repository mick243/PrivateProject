import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 계층 규칙을 **테스트로** 못 박습니다 (2026-09-28).
 *
 * 문서에만 적힌 규칙은 지켜지지 않았습니다. GUIDELINES §4-2 "실패 응답은 lib/api-errors.ts
 * 로만, 핸들러는 handle() 로 감싸라" 는 09-11 에 적혔는데, 09-28 에 재 보니 핸들러 68개 중
 * **14개**만 따르고 있었습니다 — 나머지 54개는 예외가 나면 본문 없는 500 을 냈고, 에러 JSON
 * 147곳이 손으로 쓰여 문구·모양(`details` 유무)이 라우트마다 달랐습니다. 한 번에 고친 뒤
 * 다시 벌어지지 않게 여기서 막습니다.
 *
 *   app/api/**            → lib/api-errors 의 규격으로만 답한다
 *   app/**                → DB 에 직접 붙지 않는다 (lib 의 도메인 모듈만)
 *   lib/** (앱 모듈)      → 원시 SQL API 를 쓰지 않는다 (TypedSQL 만)
 *   components/**          → 서버 전용 DB 모듈을 끌어오지 않는다
 *   scripts/*.ts           → pg 를 직접 붙잡지 않는다 (앱 데이터는 lib/prisma.ts 로 — 2026-09-28)
 *
 * 파일을 읽어 문자열로 봅니다. 정교한 파서는 아니지만, 지키려는 것이 "이 모양을 쓰지 말라"
 * 는 규칙이라 문자열로 충분하고, 실패 메시지가 곧바로 고칠 파일을 가리킵니다.
 */

const root = process.cwd();

function walk(dir: string, pick: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'generated' ? [] : walk(p, pick);
    return pick(p) ? [p] : [];
  });
}

const rel = (p: string) => path.relative(root, p).replaceAll('\\', '/');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const isTs = (p: string) => /\.(ts|tsx)$/.test(p);

const routes = walk(path.join(root, 'app', 'api'), (p) => path.basename(p) === 'route.ts');
const appFiles = walk(path.join(root, 'app'), isTs);
const libFiles = walk(path.join(root, 'lib'), isTs).filter((p) => !rel(p).startsWith('lib/typed-sql/'));
const componentFiles = walk(path.join(root, 'components'), isTs);
const scriptTsFiles = walk(path.join(root, 'scripts'), (p) => p.endsWith('.ts'));

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('app/api — 응답 규격 (lib/api-errors.ts)', () => {
  it('라우트 파일이 있다 — 경로가 바뀌어 규칙이 헛돌지 않게', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('모든 메서드 핸들러가 handle() 로 감싸여 있다 — 예외가 본문 없는 500 으로 새지 않게', () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const src = read(file);
      for (const m of METHODS) {
        if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src)) {
          offenders.push(`${rel(file)} ${m} — export function 대신 export const ${m} = handle(...)`);
        }
        const decl = new RegExp(`export\\s+const\\s+${m}\\s*=\\s*([^\\n]*)`).exec(src);
        if (decl && !decl[1].trimStart().startsWith('handle(')) {
          offenders.push(`${rel(file)} ${m} — handle() 로 감싸지 않음`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('에러 JSON 을 손으로 만들지 않는다 — fail()·notFound()·tooMany() … 를 쓴다', () => {
    const offenders = routes
      .filter((f) => /NextResponse\.json\(\s*\{\s*error\b/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('본문은 readJson·parseBody 로만 읽는다 — 깨진 JSON 이 제각각 실패하지 않게', () => {
    const offenders = routes.filter((f) => /request\.json\(\)/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('경로 id 파서를 라우트마다 다시 만들지 않는다 — parseId 하나', () => {
    const offenders = routes
      .filter((f) => /function\s+parse\w*Id\s*\(|const\s+parse\w*Id\s*=/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('계층 — 누가 DB 에 붙는가', () => {
  /** 앱 코드가 끌어오면 안 되는 데이터 계층 모듈 */
  const DB_MODULES = /from\s+['"]@\/lib\/(prisma|db|typed-sql|generated\/[^'"]*)['"]/;

  it('app/** 는 DB 모듈을 직접 import 하지 않는다 — lib 의 도메인 모듈을 거친다', () => {
    const offenders = appFiles.filter((f) => DB_MODULES.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('components/** 는 서버 전용 DB 모듈을 끌어오지 않는다', () => {
    const offenders = componentFiles.filter((f) => DB_MODULES.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('scripts/ 의 .ts 도구는 pg 를 직접 붙잡지 않는다 — 앱 데이터는 lib/prisma.ts 로 쓴다', () => {
    // 옛 어댑터 lib/db.ts(원시 SQL · PGlite 폴백)는 2026-09-28 에 지웠습니다 — 쓰던 도구 6개를
    // Prisma 로 옮기고 나니 쓰는 곳이 없었습니다. `.mjs` 러너(migrate · init-db · prisma-baseline)는
    // 스키마 자체를 다루는 도구라 이 규칙 밖입니다 (docs/DATA-SOURCES.md §5).
    expect(scriptTsFiles.length).toBeGreaterThan(5);
    const rawDriver = /from\s+['"]pg['"]|import\(\s*['"]pg['"]\s*\)|\/lib\/db(\.ts)?['"]/;
    const offenders = scriptTsFiles.filter((f) => rawDriver.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('원시 SQL API($queryRaw·$executeRaw·…Unsafe)를 부르지 않는다 — SQL 은 prisma/sql 의 TypedSQL 로만', () => {
    // TypedSQL($queryRawTyped)은 파라미터가 타입과 함께 바인딩됩니다. 문자열을 이어 붙이는
    // 길(…Unsafe)이 앱에 한 줄도 없어야 "SQL 인젝션 0" 이 계속 참입니다 (GUIDELINES §2).
    // `.` 을 앞에 요구합니다 — 호출은 늘 `prisma.$queryRaw…` 꼴이고, 주석 속 "`$queryRaw` 계열" 은 거릅니다.
    const rawCall = /\.\$(queryRaw|executeRaw)(Unsafe)?\s*[`(]/;
    const offenders = [...appFiles, ...libFiles].filter((f) => rawCall.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
});
