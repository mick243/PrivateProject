import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INDEX_FILE,
  TYPED_SQL_DIR,
  check,
  embeddedSql,
  foldSql,
  queryNames,
  readSource,
  recordedHash,
  sourceHash,
} from '@/scripts/prisma-typed-sql.mjs';

/**
 * `lib/typed-sql/` 가 `prisma/sql/` 과 어긋나지 않았는지 — **DB 없이** 봅니다.
 *
 * 모듈 안에 SQL 문자열이 박혀 있어서, `.sql` 만 고치고 `npm run db:prisma:sql` 을 잊으면
 * 실행되는 것은 옛 SQL 입니다. 타입 검사도 통과합니다(옛 타입이 그대로 있으니까).
 * 그래서 이 테스트가 없으면 **아무도 모르게** 어긋납니다. CI 가 DB 없이 도는 이유와
 * 이 폴더가 생성물인데도 커밋되는 이유는 scripts/prisma-typed-sql.mjs 머리말에 있습니다.
 */
describe('lib/typed-sql', () => {
  const names = queryNames();

  it('prisma/sql 의 쿼리마다 모듈이 하나씩 있다', () => {
    expect(names.length).toBeGreaterThan(0);
    const { missing, orphan } = check();
    expect({ missing, orphan }).toEqual({ missing: [], orphan: [] });
  });

  it('모듈 머리의 해시가 지금 원본과 같다 — 다르면 npm run db:prisma:sql', () => {
    const stale = names.filter((n) => {
      const text = fs.readFileSync(path.join(TYPED_SQL_DIR, `${n}.ts`), 'utf8');
      return recordedHash(text) !== sourceHash(readSource(n));
    });
    expect(stale).toEqual([]);
  });

  it('모듈에 박힌 SQL 이 원본과 같다 — 해시만 맞추고 본문을 손으로 고친 경우', () => {
    const edited = names.filter((n) => {
      const text = fs.readFileSync(path.join(TYPED_SQL_DIR, `${n}.ts`), 'utf8');
      return foldSql(embeddedSql(text) ?? '') !== foldSql(readSource(n));
    });
    expect(edited).toEqual([]);
  });

  it(`${INDEX_FILE} 가 쿼리 전부를 내보낸다`, () => {
    expect(check().indexOk).toBe(true);
  });

  it('해시는 줄바꿈(CRLF/LF)에 흔들리지 않는다 — Windows 체크아웃에서도 같은 값', () => {
    expect(sourceHash('SELECT 1;\r\nSELECT 2;\r\n')).toBe(sourceHash('SELECT 1;\nSELECT 2;\n'));
  });

  it('SQL 을 한 글자라도 바꾸면 대조가 잡는다', () => {
    const [first] = names;
    const original = readSource(first);
    expect(sourceHash(`${original}\n-- 한 줄 추가`)).not.toBe(sourceHash(original));
    expect(foldSql(`${original}\nLIMIT 1`)).not.toBe(foldSql(original));
  });

  it('모듈은 생성된 클라이언트 폴더를 참조하지 않는다 — 그래야 커밋해도 자립한다', () => {
    for (const n of names) {
      const text = fs.readFileSync(path.join(TYPED_SQL_DIR, `${n}.ts`), 'utf8');
      expect(text).not.toMatch(/from ['"][^'"]*generated/);
      expect(text).toContain('@prisma/client/runtime/client');
    }
  });
});

/**
 * 오락실 조건 블록은 두 파일에 **글자까지 같게** 있습니다 (2026-09-28).
 *
 * 챗봇의 한 쪽(pageArcades)은 arcadeSearchPage.sql 로 id 를 고르고 arcadesWithMachines.sql 로 그
 * id 들만 집계합니다. 쪽 나누기를 한 SQL 안에 넣으면 지도 목록이 느려져서(그 SQL 머리말) 둘로
 * 나눴고, 대신 조건이 두 벌이 됐습니다. 한쪽만 고치면 챗봇이 "강남에 3곳" 이라 하는데 지도에는
 * 4곳이 뜹니다 — 조용히 어긋나는 종류라 여기서 막습니다.
 */
describe('prisma/sql — 오락실 조건 블록', () => {
  const block = (file: string) => {
    const lines = fs.readFileSync(path.join(process.cwd(), 'prisma', 'sql', file), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const from = lines.indexOf('-- ▼ 조건');
    const to = lines.indexOf('-- ▲ 조건');
    return from >= 0 && to > from ? lines.slice(from, to + 1).join('\n') : null;
  };

  it('arcadeSearchPage.sql 과 arcadesWithMachines.sql 의 조건 블록이 같다', () => {
    const list = block('arcadesWithMachines.sql');
    expect(list).not.toBeNull();
    expect(list!.split('\n').length).toBeGreaterThan(20); // 표시가 엉뚱한 곳에 붙어 빈 블록끼리 같아지지 않게
    expect(block('arcadeSearchPage.sql')).toBe(list);
  });
});
