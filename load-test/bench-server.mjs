/**
 * A/B 측정용 프로덕션 서버 — 산출물 위치와 포트, 풀 상한을 인자로 받습니다.
 *
 * 왜 이게 필요한가: 처리량 A/B 를 순차로 재면 배경 프로세스 드리프트가 효과를
 * 완전히 덮습니다 (PERFORMANCE.md '2부의 측정 방법' — 같은 코드가 631 → 463 req/s
 * 로 흘러내려 반대 결론이 났습니다). BEFORE/AFTER 를 각자 포트에 **동시에** 띄우고
 * 번갈아 재야 드리프트가 양쪽에 똑같이 걸려 상쇄됩니다. 그러려면 두 빌드가 동시에
 * 존재해야 하고, 그래서 next.config.mjs 의 distDir 을 NEXT_DIST_DIR 로 바꿉니다.
 *
 * 사용:
 *   NEXT_DIST_DIR=.next-before npm run build
 *   node load-test/bench-server.mjs .next-before 3100 35
 *
 * 인자: <distDir> <port> [poolMax]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [distDir, port, poolMax] = process.argv.slice(2);

if (!distDir || !port) {
  console.error('사용법: node load-test/bench-server.mjs <distDir> <port> [poolMax]');
  process.exit(1);
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = resolve(appDir, 'node_modules/next/dist/bin/next');

const env = { ...process.env, NEXT_DIST_DIR: distDir, NODE_ENV: 'production' };
// 풀 상한은 두 서버가 같아야 비교가 성립합니다 (lib/db.ts PG_POOL_MAX, 기본 30).
if (poolMax) env.PG_POOL_MAX = poolMax;

console.log(`[bench] ${distDir} → :${port} (PG_POOL_MAX=${env.PG_POOL_MAX ?? '기본값'})`);

const child = spawn(process.execPath, [nextBin, 'start', appDir, '-p', port], {
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
