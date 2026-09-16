import fs from 'node:fs';
import path from 'node:path';

/**
 * `.env.local` 을 process.env 로 올린다 — **scripts/ 의 도구 전용**.
 *
 * 앱(Next.js)은 이 파일을 알아서 읽지만, `node scripts/….ts` 로 도는 도구는 평범한
 * Node 프로세스라 아무것도 읽지 않습니다. 그대로 두면 `DATABASE_URL` 이 비어 있어
 * lib/db.ts 가 **실제 Postgres 대신 .pglite 로 내려갑니다** — 도구는 멀쩡히 끝났다고
 * 말하는데 실 DB 에는 아무것도 안 들어가는, 알아채기 어려운 실패입니다.
 *
 * 그래서 DB 를 건드리는 스크립트는 **첫 getDb() 앞에서** 이걸 불러야 합니다.
 * (getDb 는 호출 시점에 env 를 읽으므로 import 순서까지 맞출 필요는 없습니다.)
 *
 * dotenv 를 넣지 않는 이유: 이 한 가지 때문에 의존성을 늘릴 일이 아닙니다.
 * 이미 있는 값은 덮지 않습니다 — 명령줄에서 준 값이 파일보다 우선입니다.
 *
 * ⚠ scripts/init-db.mjs 에도 같은 블록이 있습니다. 그쪽은 `.mjs` 라 이 `.ts` 를
 *   import 할 수 없어서 어쩔 수 없이 복제돼 있습니다 — 규칙을 고치면 그쪽도 같이.
 */
export function loadScriptEnv(root = process.cwd()): void {
  const envFile = path.join(root, '.env.local');
  if (!fs.existsSync(envFile)) return;

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) {
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

/**
 * 지금 어느 DB 를 보고 있는지 한 줄로. 도구가 시작할 때 찍어 주면, 실 DB 인 줄 알고
 * 돌렸는데 .pglite 였던 일을 **끝난 뒤가 아니라 시작할 때** 알 수 있습니다.
 */
export function describeTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return '로컬 사본 .pglite (DATABASE_URL 이 없습니다)';
  // 비밀번호는 찍지 않는다.
  return `PostgreSQL ${url.replace(/:\/\/[^@]*@/, '://***@')}`;
}
