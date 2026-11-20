/**
 * 운영 기동 — 목표 규모(가입자 10,000 · DAU 3,000) 권고 구성
 *
 *   인스턴스 2개 × PG_POOL_MAX=10  (합 20)
 *
 * ─── 왜 2개인가 ───────────────────────────────────────────────
 * **속도 때문이 아닙니다.** 1개가 목표의 10배(25 req/s)를 p95 159ms 로 받아내고,
 * 69.7 req/s(20배)까지 올려도 실패 0% 였습니다 (PERFORMANCE.md 4부 15절).
 * 2개인 이유는 **한쪽이 죽어도 서비스가 사는 것** 하나입니다. 1개짜리 구성에서는
 * 그 프로세스가 죽는 순간 사이트 전체가 내려갑니다. 배포 때 하나씩 갈아 끼우는
 * 무중단 재기동(아래 SIGHUP)도 같은 이유로 2개부터 됩니다.
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
 * ─── 무중단 재기동 (SIGHUP) ───────────────────────────────────
 * `kill -HUP <이 프로세스>` (= `systemctl reload arcade-finder`) 를 받으면 인스턴스를
 * **하나씩** 교체합니다: 프록시에서 빼고 → 진행 중 요청이 끝나길 기다리고 → 끄고 →
 * 새로 띄우고 → `/api/health` 200 을 본 뒤 다음으로. 그동안 나머지가 트래픽을 받습니다.
 * 90초 안에 준비되지 않으면 거기서 멈추고, 아직 안 바꾼 인스턴스는 옛 코드로 계속 돕니다.
 *
 * ⚠ 무중단은 **인스턴스가 2개 이상일 때만**입니다. INSTANCES=1(NCP Micro 1GB —
 *   deploy/ncp/bootstrap.sh 의 drop-in)이면 받아 줄 쪽이 없어서, 새 인스턴스가 준비될
 *   때까지 프록시가 503 + Retry-After 를 돌려줍니다(2026-10-06 컨테이너 실측 0.7초 —
 *   1 vCPU 서버에선 더 깁니다). systemctl restart 보다 짧을 뿐 0 은 아닙니다.
 * ⚠ 터미널에서 띄운 경우 터미널을 닫아도(SIGHUP) 내려가지 않고 교체가 돕니다.
 *   끄려면 Ctrl+C(SIGINT) 나 SIGTERM.
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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = resolve(appDir, 'node_modules/next/dist/bin/next');

const PORT = Number(process.env.PORT) || 3000;
const INSTANCES = Number(process.env.INSTANCES) || 2;
const POOL_MAX = Number(process.env.PG_POOL_MAX) || 10;
const PORT_BASE = Number(process.env.INSTANCE_PORT_BASE) || 3001;

/**
 * 빌드된 커밋. `.next/BUILD_ID` 는 빌드마다 바뀌는 난수라 로그 대조에는 git 해시가 낫습니다.
 *
 * 서버에 깔린 배포 묶음에는 .git 이 없어 git 으로는 못 읽습니다 — 그래서 예전에는 운영의
 * /api/health version 이 늘 'unknown' 이었고, 무엇이 깔렸는지 알 길이 없었습니다. 묶음을 만들 때
 * build-release.sh 가 커밋을 VERSION 파일에 적어 두므로 그것을 먼저 봅니다.
 */
const APP_VERSION = (() => {
  try {
    const fromFile = readFileSync(resolve(appDir, 'VERSION'), 'utf8').trim();
    if (/^[0-9a-f]{7,40}(-dirty)?$/.test(fromFile)) return fromFile;
  } catch {
    // 개발 체크아웃에는 VERSION 이 없다 — git 으로
  }
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

/** 교체(SIGHUP) — 진행 중 요청을 기다리는 상한 · SIGTERM 뒤 SIGKILL 까지 · 새 인스턴스 준비 상한 */
const DRAIN_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 90_000;

/**
 * draining — 교체 중이라 프록시가 새 요청을 보내지 않는 상태 (up 이어도)
 * inflight — 이 인스턴스로 넘겨 아직 응답이 끝나지 않은 요청 수. 빼기 전에 0 이 되길 기다립니다
 * stopping — 교체하려고 일부러 끄는 중. 이때의 종료는 "죽음" 이 아니라 재기동하지 않습니다
 *
 * @type {{port:number, child:import('node:child_process').ChildProcess|null, up:boolean, backoff:number,
 *   restartTimer:NodeJS.Timeout|null, draining:boolean, inflight:number, stopping:boolean}[]}
 */
const instances = Array.from({ length: INSTANCES }, (_, i) => ({
  port: PORT_BASE + i,
  child: null,
  up: false,
  backoff: RESTART_DELAY_MS,
  restartTimer: null,
  draining: false,
  inflight: 0,
  stopping: false,
}));

let shuttingDown = false;

function start(inst) {
  if (shuttingDown || inst.child) return;
  // 백오프로 잡아 둔 재기동이 남아 있으면 지웁니다 — 교체가 먼저 띄웠는데 타이머가 또 띄우면
  // 같은 포트에 둘이 붙으려다 하나가 EADDRINUSE 로 죽습니다.
  clearTimeout(inst.restartTimer);
  inst.restartTimer = null;

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
       * 쪽도 정본이 아닙니다. (09-22 Prisma 이관 뒤의 앱에는 폴백이 아예 없어 이 값을 읽는
       * 곳이 없습니다 — Prisma 이전 코드로 되돌렸을 때를 위해 남겨 둡니다.) 밖에서 명시하면 그 값.
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
    // 교체 중에 일부러 끈 것이면 rollingRestart 가 바로 다시 띄웁니다
    if (shuttingDown || inst.stopping) return;

    // 여기가 "2개인 이유" 입니다 — 한쪽이 죽어도 다른 쪽이 계속 받고, 죽은 쪽은
    // 다시 올라옵니다. 그동안 프록시는 죽은 포트를 건너뜁니다.
    console.error(
      `[cluster] :${inst.port} 종료 (code=${code} signal=${signal}) — ${inst.backoff}ms 뒤 재기동`,
    );
    inst.restartTimer = setTimeout(() => start(inst), inst.backoff);
    inst.backoff = Math.min(inst.backoff * 2, RESTART_DELAY_MAX_MS);
  });

  console.log(`[cluster] :${inst.port} 기동 (PG_POOL_MAX=${POOL_MAX})`);
}

/**
 * 헬스체크. 인스턴스가 "떴다" 를 포트 바인딩이 아니라 `/api/health` 200 으로
 * 판정합니다 — 바인딩만 보면 DB 가 안 붙은 인스턴스에도 트래픽이 갑니다.
 */
function probe(inst) {
  // 보낼 때의 자식을 기억해 둡니다. 교체 직전에 옛 자식에게 보낸 점검이 늦게 200 으로
  // 돌아와 아직 포트도 안 연 새 자식을 "준비됨" 으로 만들면, 그 사이 요청이 502 가 됩니다.
  const child = inst.child;
  const req = http.request(
    { host: '127.0.0.1', port: inst.port, path: '/api/health', method: 'GET', timeout: 2000 },
    (res) => {
      res.resume();
      if (inst.child !== child) return;
      const ok = res.statusCode === 200;
      if (ok && !inst.up) {
        console.log(`[cluster] :${inst.port} 준비됨`);
        inst.backoff = RESTART_DELAY_MS; // 한 번 제대로 떴으면 백오프를 되돌립니다
      }
      inst.up = ok;
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => {
    if (inst.child === child) inst.up = false;
  });
  req.end();
}

setInterval(() => instances.forEach(probe), 2000).unref?.();

/** 라운드로빈 커서 — 살아 있고 교체 중이 아닌 인스턴스만 돕니다 */
let cursor = 0;
function pick() {
  for (let i = 0; i < instances.length; i += 1) {
    const inst = instances[(cursor + i) % instances.length];
    if (inst.up && !inst.draining) {
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

  // 교체할 때 "이 인스턴스로 간 요청이 다 끝났나" 를 이 수로 봅니다. close 는 응답을 다 보냈을
  // 때도, 클라이언트가 끊었을 때도 한 번 옵니다.
  inst.inflight += 1;
  res.once('close', () => { inst.inflight -= 1; });

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

/** cond() 가 참이 될 때까지 everyMs 마다 봅니다. 시간이 다 됐거나 내려가는 중이면 false */
function waitFor(cond, timeoutMs, everyMs = 500, onTick = undefined) {
  return new Promise((done) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (cond()) return done(true);
      if (shuttingDown || Date.now() >= deadline) return done(false);
      onTick?.();
      setTimeout(tick, everyMs);
    };
    tick();
  });
}

/** 자식을 SIGTERM 으로 내리고 끝날 때까지 기다립니다. 안 내려가면 STOP_TIMEOUT_MS 뒤 SIGKILL */
function stop(inst) {
  const { child } = inst;
  if (!child) return Promise.resolve();
  inst.stopping = true;
  return new Promise((done) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    // start() 의 exit 핸들러가 먼저 불려 stopping 을 보고 재기동을 건너뜁니다
    child.once('exit', () => {
      clearTimeout(killTimer);
      inst.stopping = false;
      done();
    });
    child.kill('SIGTERM');
  });
}

/** 인스턴스 하나를 교체합니다. 새 인스턴스가 READY_TIMEOUT_MS 안에 /api/health 200 이면 true */
async function replace(inst) {
  const startedAt = Date.now();
  inst.draining = true;
  console.log(`[cluster] :${inst.port} 교체 시작 — 프록시에서 빼고 진행 중 요청 ${inst.inflight}건을 기다립니다`);
  // 보통 수 ms 안에 끝납니다. 인스턴스가 1개면 여기서 기다리는 시간도 고스란히 503 이라 촘촘히 봅니다
  const drained = await waitFor(() => inst.inflight === 0, DRAIN_TIMEOUT_MS, 50);
  if (!drained && !shuttingDown) {
    console.warn(
      `[cluster] ⚠ :${inst.port} 진행 중 요청 ${inst.inflight}건이 ${DRAIN_TIMEOUT_MS / 1000}초 안에 안 끝나 그대로 내립니다`,
    );
  }
  await stop(inst);

  // 새 자식은 draining 이 풀려 있어도 /api/health 200(up)이 나오기 전에는 트래픽을 받지 않습니다
  inst.draining = false;
  inst.backoff = RESTART_DELAY_MS;
  start(inst);
  // 준비됐는지는 2초 주기 점검을 기다리지 않고 0.25초마다 직접 찔러 봅니다 — 인스턴스가 1개면 그만큼이 끊기는 시간입니다
  const ready = await waitFor(() => inst.up, READY_TIMEOUT_MS, 250, () => probe(inst));
  if (ready) console.log(`[cluster] :${inst.port} 교체 완료 (${((Date.now() - startedAt) / 1000).toFixed(1)}초)`);
  return ready;
}

let rolling = false;
let rollAgain = false;

/**
 * SIGHUP — 인스턴스를 하나씩 교체합니다 (머리말 "무중단 재기동" 참고).
 * systemctl reload 는 신호만 보내고 바로 돌아오므로, 끝났는지는 로그의 "교체 끝" 줄로 봅니다.
 */
async function rollingRestart() {
  if (shuttingDown) return;
  if (rolling) {
    // 교체 도중 배포가 또 들어왔습니다 — 이미 바꾼 인스턴스는 그 전 빌드이므로 끝나면 한 바퀴 더 돕니다
    rollAgain = true;
    console.log('[cluster] SIGHUP — 교체 중입니다. 끝나면 한 번 더 돕니다');
    return;
  }
  rolling = true;
  const startedAt = Date.now();
  if (INSTANCES === 1) {
    console.log('[cluster] SIGHUP — 인스턴스를 교체합니다');
    console.warn('[cluster] ⚠ 인스턴스가 1개라 받아 줄 쪽이 없습니다 — 새로 뜰 때까지 503 이 나갑니다');
  } else {
    console.log(`[cluster] SIGHUP — 인스턴스 ${INSTANCES}개를 하나씩 교체합니다`);
  }

  let replaced = 0;
  try {
    // 지금 트래픽을 안 받는 인스턴스(죽었거나 뜨는 중)부터 — 그쪽은 바꿔도 잃는 것이 없습니다
    const order = [...instances].sort((a, b) => Number(a.up) - Number(b.up));
    for (const inst of order) {
      if (shuttingDown) break;
      // 받고 있는 인스턴스를 빼려면 다른 하나가 받고 있어야 합니다. 방금 죽어 재기동 중이면 기다립니다
      if (inst.up && INSTANCES > 1) {
        const covered = await waitFor(
          () => instances.some((o) => o !== inst && o.up && !o.draining),
          READY_TIMEOUT_MS,
        );
        if (!covered) {
          if (!shuttingDown) {
            console.error(`[cluster] ✗ 다른 인스턴스가 살아 있지 않아 :${inst.port} 를 뺄 수 없습니다 — 교체를 멈춥니다`);
          }
          break;
        }
      }
      if (!(await replace(inst))) {
        if (!shuttingDown) {
          console.error(
            `[cluster] ✗ :${inst.port} 가 ${READY_TIMEOUT_MS / 1000}초 안에 준비되지 않아 교체를 멈춥니다 — ` +
              `안 바꾼 ${INSTANCES - replaced - 1}개는 옛 코드로 계속 돕니다`,
          );
        }
        break;
      }
      replaced += 1;
    }
  } finally {
    rolling = false;
  }

  if (replaced === INSTANCES) {
    const what = INSTANCES === 1 ? '인스턴스가' : `${INSTANCES}개 모두`;
    console.log(`[cluster] 교체 끝 — ${what} 새로 떴습니다 (${((Date.now() - startedAt) / 1000).toFixed(1)}초)`);
  }
  if (rollAgain && !shuttingDown) {
    rollAgain = false;
    rollingRestart();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Node 의 SIGHUP 기본 동작은 "종료" 입니다. 이 줄이 없으면 systemctl reload 가 런처를 죽이고, systemd 가
// 남은 자식까지 정리한 뒤 Restart=always 로 다시 띄울 때까지 사이트가 내려갑니다(2026-10-06 실측 5.5초).
// systemd 밖에서 띄웠다면 런처만 죽고 자식은 고아로 3001·3002 를 문 채 남습니다.
process.on('SIGHUP', () => { rollingRestart(); });

instances.forEach(start);
proxy.listen(PORT, () => {
  console.log(
    `[cluster] :${PORT} 대기 — 인스턴스 ${INSTANCES}개 × 풀 ${POOL_MAX} (합 ${INSTANCES * POOL_MAX})`,
  );
});
