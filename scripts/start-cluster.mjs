/**
 * 운영 기동 — 목표 규모(가입자 10,000 · DAU 3,000) 권고 구성
 *
 *   인스턴스 2개 × PG_POOL_MAX=10  (합 20)
 *
 * ─── 왜 2개인가 ───────────────────────────────────────────────
 * **속도 때문이 아닙니다.** 1개가 목표의 10배(25 req/s)를 p95 159ms 로 받아내고,
 * 69.7 req/s(20배)까지 올려도 실패 0% 였습니다 (PERFORMANCE.md 4부 15절).
 * 2개인 이유는 **한쪽이 죽어도 서비스가 사는 것** 하나입니다. 1개짜리 구성에서는
 * 그 프로세스가 죽는 순간 사이트 전체가 내려갑니다.
 *
 * ─── 왜 next start 를 그대로 쓰는가 ───────────────────────────
 * node:cluster + 커스텀 서버로 포트를 공유하면 프록시 홉이 없어서 더 깔끔합니다.
 * 그런데 4부의 모든 수치가 **`next start` 로 잰 것**입니다. 커스텀 서버로 갈아타면
 * 방금 세운 기준선이 그대로 무효가 됩니다. 그래서 `next start` 는 손대지 않고
 * 앞에 얇은 프록시를 둡니다.
 *
 * ─── 이 프록시가 병목이 아닌 이유 ─────────────────────────────
 * 2부는 "노드로 프록시를 만들면 그게 단일 스레드라 천장이 프록시로 옮겨온다" 고
 * 적었고, **1,700 req/s 를 재던 그 맥락에서는 맞습니다.** 목표는 3.4 req/s(피크
 * 버스트 10 req/s)이라 두 자릿수 아래이고, 단일 노드 프로세스는 그보다 두 자릿수
 * 위를 받습니다. 트래픽이 수백 req/s 에 가까워지면 그때 nginx·caddy 로 옮기고
 * `API_COMPRESSION=off` 로 압축도 넘기세요.
 *
 * ─── 쓰는 법 ─────────────────────────────────────────────────
 *   npm run build
 *   npm run start:cluster
 *
 * 환경변수로 조절합니다 (기본값이 곧 권고값입니다).
 *   PORT            공개 포트            기본 3000
 *   INSTANCES       인스턴스 수           기본 2
 *   PG_POOL_MAX     인스턴스당 풀 상한     기본 10
 *   INSTANCE_PORT_BASE  내부 포트 시작     기본 3001
 *
 * ⚠ `PG_POOL_MAX × INSTANCES` 가 Postgres `max_connections`(기본 100)를 넘으면
 *   안 됩니다. 기본값은 20 이라 인스턴스를 9개까지 늘려도 여유가 있습니다.
 */
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = resolve(appDir, 'node_modules/next/dist/bin/next');

const PORT = Number(process.env.PORT) || 3000;
const INSTANCES = Number(process.env.INSTANCES) || 2;
const POOL_MAX = Number(process.env.PG_POOL_MAX) || 10;
const PORT_BASE = Number(process.env.INSTANCE_PORT_BASE) || 3001;

/** 빌드된 커밋. `.next/BUILD_ID` 는 빌드마다 바뀌는 난수라 로그 대조에는 git 해시가 낫습니다 */
const APP_VERSION = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appDir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();

if (POOL_MAX * INSTANCES > 90) {
  console.warn(
    `[cluster] ⚠ 풀 ${POOL_MAX} × 인스턴스 ${INSTANCES} = ${POOL_MAX * INSTANCES} — ` +
      'max_connections(기본 100)에 여유가 없습니다. 둘 중 하나를 내리세요.',
  );
}

/** 죽은 인스턴스를 다시 띄울 때, 계속 즉사하면 간격을 벌립니다 */
const RESTART_DELAY_MS = 1000;
const RESTART_DELAY_MAX_MS = 30_000;

/** @type {{port:number, child:import('node:child_process').ChildProcess|null, up:boolean, backoff:number}[]} */
const instances = Array.from({ length: INSTANCES }, (_, i) => ({
  port: PORT_BASE + i,
  child: null,
  up: false,
  backoff: RESTART_DELAY_MS,
}));

let shuttingDown = false;

function start(inst) {
  if (shuttingDown) return;

  // `-H 127.0.0.1`: 내부 포트는 이 프록시만 붙습니다. 모든 인터페이스에 열어 두면
  // 3001/3002 로 직접 들어와 X-Forwarded-For 를 마음대로 적을 수 있고, 그러면
  // TRUSTED_PROXY_HOPS 로 세운 IP 신뢰가 무너집니다 (2026-09-13 QA H5).
  const child = spawn(
    process.execPath,
    [nextBin, 'start', appDir, '-p', String(inst.port), '-H', '127.0.0.1'],
    {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PG_POOL_MAX: String(POOL_MAX),
      PORT: String(inst.port),
      /**
       * 운영에서 PGlite 폴백은 끕니다 — 인스턴스 2개가 각자 다른 사본에 쓰면 어느
       * 쪽도 정본이 아닙니다 (lib/db.ts FALLBACK_ENABLED). 밖에서 명시하면 그 값.
       */
      DB_FALLBACK: process.env.DB_FALLBACK ?? 'off',
      /** /api/health 의 version 칸. 배포 스크립트가 커밋 해시를 넣어 주면 그대로 */
      APP_VERSION: process.env.APP_VERSION ?? APP_VERSION,
      /**
       * 이 프록시가 홉을 **정확히 하나** 더합니다 (아래 x-forwarded-for).
       * 앱은 그 수를 알아야 체인의 오른쪽에서 실제 클라이언트를 짚을 수 있습니다
       * (lib/auth.ts clientKey — 왼쪽부터 읽으면 위조된 값을 믿게 됩니다).
       * 이 앞에 nginx 를 또 둔다면 밖에서 2 를 주세요.
       */
      TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS ?? '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    },
  );

  inst.child = child;
  inst.up = false;

  child.on('exit', (code, signal) => {
    inst.child = null;
    inst.up = false;
    if (shuttingDown) return;

    // 여기가 "2개인 이유" 입니다 — 한쪽이 죽어도 다른 쪽이 계속 받고, 죽은 쪽은
    // 다시 올라옵니다. 그동안 프록시는 죽은 포트를 건너뜁니다.
    console.error(
      `[cluster] :${inst.port} 종료 (code=${code} signal=${signal}) — ${inst.backoff}ms 뒤 재기동`,
    );
    setTimeout(() => start(inst), inst.backoff);
    inst.backoff = Math.min(inst.backoff * 2, RESTART_DELAY_MAX_MS);
  });

  console.log(`[cluster] :${inst.port} 기동 (PG_POOL_MAX=${POOL_MAX})`);
}

/**
 * 헬스체크. 인스턴스가 "떴다" 를 포트 바인딩이 아니라 `/api/health` 200 으로
 * 판정합니다 — 바인딩만 보면 DB 가 안 붙은 인스턴스에도 트래픽이 갑니다.
 */
function probe(inst) {
  const req = http.request(
    { host: '127.0.0.1', port: inst.port, path: '/api/health', method: 'GET', timeout: 2000 },
    (res) => {
      res.resume();
      const ok = res.statusCode === 200;
      if (ok && !inst.up) {
        console.log(`[cluster] :${inst.port} 준비됨`);
        inst.backoff = RESTART_DELAY_MS; // 한 번 제대로 떴으면 백오프를 되돌립니다
      }
      inst.up = ok;
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => { inst.up = false; });
  req.end();
}

setInterval(() => instances.forEach(probe), 2000).unref?.();

/** 라운드로빈 커서 — 살아 있는 인스턴스만 돕니다 */
let cursor = 0;
function pick() {
  for (let i = 0; i < instances.length; i += 1) {
    const inst = instances[(cursor + i) % instances.length];
    if (inst.up) {
      cursor = (cursor + i + 1) % instances.length;
      return inst;
    }
  }
  return null;
}

const proxy = http.createServer((req, res) => {
  const inst = pick();
  if (!inst) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2' });
    res.end(JSON.stringify({ error: '서버가 준비 중입니다. 잠시 후 다시 시도해 주세요' }));
    return;
  }

  const headers = { ...req.headers };
  /**
   * 실제 소켓 주소를 체인 **맨 뒤**에 붙입니다. 클라이언트가 보낸 값은 지우지
   * 않고 그대로 남기는 것이 표준이고, 앱은 오른쪽에서 세어 위조값을 지나칩니다
   * (TRUSTED_PROXY_HOPS=1 → 맨 뒤가 진짜). 덮어쓰면 앞단에 프록시를 더 둘 때
   * 그쪽 정보가 사라집니다.
   */
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress]
    .filter(Boolean)
    .join(', ');
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';
  headers['x-forwarded-host'] = req.headers.host ?? '';

  const upstream = http.request(
    { host: '127.0.0.1', port: inst.port, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    // 이 인스턴스는 방금 죽은 것으로 봅니다. 다음 헬스체크가 확인해 줍니다.
    inst.up = false;
    console.error(`[cluster] :${inst.port} 전달 실패 — ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '일시적인 오류입니다. 다시 시도해 주세요' }));
    } else {
      res.destroy();
    }
  });

  req.pipe(upstream);
});

// 업그레이드(WebSocket)는 `next start` 경로에서 쓰이지 않지만, 오면 끊지 말고 넘깁니다.
proxy.on('upgrade', (req, socket, head) => {
  const inst = pick();
  if (!inst) return socket.destroy();

  const upstream = http.request({
    host: '127.0.0.1',
    port: inst.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.unshift(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  if (head?.length) upstream.write(head);
  upstream.end();
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[cluster] ${signal} — 내려갑니다`);
  proxy.close();
  for (const inst of instances) inst.child?.kill();
  // 자식이 안 내려가면 강제로. 매달린 프로세스가 포트를 물면 다음 기동이 실패합니다.
  setTimeout(() => {
    for (const inst of instances) inst.child?.kill('SIGKILL');
    process.exit(0);
  }, 5000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

instances.forEach(start);
proxy.listen(PORT, () => {
  console.log(
    `[cluster] :${PORT} 대기 — 인스턴스 ${INSTANCES}개 × 풀 ${POOL_MAX} (합 ${INSTANCES * POOL_MAX})`,
  );
});
