/**
 * Caddy 접근 로그 → 요청 수 지표 (엣지 계측).
 *
 * [왜 앱 안이 아니라 로그를 읽나]
 *   lib/telemetry.ts 는 Next 핸들러까지 들어온 요청만 셉니다 (그마저 /_next · /api/health 는 뺍니다).
 *   Caddy 는 앱 앞에 있어서 **사이트로 온 모든 요청**을 봅니다 — 페이지 · 정적 파일 · 봇 · 스캐너 · 404,
 *   그리고 앱이 죽었을 때 Caddy 가 대신 돌려준 502/503. 앱이 죽으면 앱 계측은 조용해지지만
 *   이쪽은 그 5xx 를 그대로 셉니다. 두 계측은 겹치지 않고 서로의 빈자리를 메웁니다.
 *
 * [쓰는 법]
 *   상주(systemd)   node scripts/caddy-traffic.mjs
 *                   30초마다 집계해서 Pulse 로 보내고(PULSE_API_URL · PULSE_EDGE_KEY 가 있을 때) 요약을 로그로 남깁니다.
 *   한 번 집계      node scripts/caddy-traffic.mjs --summary [로그 파일…]
 *                   지금 남아 있는 로그 전체를 읽어 표로 보여 줍니다 — Pulse 없이도 됩니다.
 *
 * [환경변수]
 *   CADDY_LOG            기본 /var/log/caddy/arcade-finder.log (deploy/ncp/Caddyfile 의 log 블록)
 *   PULSE_API_URL        Pulse 수집 API 주소. 앱의 PULSE_API_URL 과 같은 값
 *   PULSE_EDGE_KEY       Pulse 에서 **따로 만든** AGENT 대상의 키. 앱 계측(PULSE_AGENT_KEY)과 같은 키를 쓰지 않습니다 —
 *                        같은 대상에 섞으면 app.http.* 와 edge.req.* 가 한 차트에 뒤엉킵니다.
 *   PULSE_EDGE_AGENT_ID  기본 arcade-finder-edge
 *
 * [지표 이름 — Pulse 는 라벨이 없어 이름에 담습니다. 64자 제한, 마지막 점 뒤가 통계 이름]
 *   edge.req.rpm | 2xx | 3xx | 4xx | 5xx | p95_ms     전체 요청 (rpm 은 분당, 상태는 그 창의 건수)
 *   edge.kind.page|api|static|other.rpm                종류별 분당 요청
 *   edge.bot.rpm                                       봇·스크립트 추정 (UA 기준 — 추정치입니다)
 *   edge.route.<METHOD /경로/[id]>.rpm | 5xx           페이지·API 경로별 (정적 파일은 경로별로 안 셉니다)
 *   edge.log.ok                                        1 = 로그를 읽고 있음, 0 = 못 읽음
 *
 * ⚠ 요청이 0건인 창에도 위 기본 지표를 전부 보냅니다. "조용한 것" 과 "수집기가 죽은 것" 을 가르기 위해서입니다 —
 *   수집기가 죽으면 Pulse 의 하트비트가 침묵을 잡고, 로그를 못 읽으면 edge.log.ok 가 0 이 됩니다.
 *   Caddy 의 로그 파일은 기본 권한이 600 이라 caddy 사용자가 아니면 못 읽습니다 — 그 실수가 가장 흔합니다.
 *
 * ⚠ 요청 한 건 한 건은 어디에도 저장하지 않습니다. IP · UA · 쿼리스트링은 집계에만 쓰고 버립니다.
 *
 * ⚠ 로그가 회전(Caddy 가 10MiB 마다 새 파일로 바꿈)하는 순간 옛 파일에서 못 읽은 마지막 1초 안팎의 줄은 놓칩니다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const FLUSH_MS = 30_000;
const POLL_MS = 1_000;
/** 경로 종류 상한 — 넘어가면 '(other)' 로 묶어 카디널리티 폭발을 막는다 (lib/telemetry.ts 와 같은 값) */
const MAX_KEYS = 150;
/** 'edge.route.'(11) + 키 + '.rpm'/'.5xx'(4) 가 64자 안에 들어와야 한다 */
const KEY_MAX_LEN = 48;
/** p95 표본 상한 — 넘어가면 저수지 표본(reservoir sampling) */
const MAX_SAMPLES = 500;
const MAX_PATH_LEN = 200;
/** 한 번에 읽는 최대 바이트. 한꺼번에 몰려도 메모리가 튀지 않게 끊어 읽는다 */
const READ_CHUNK = 4 * 1024 * 1024;
const PUSH_BATCH = 2000; // Pulse 수집 API 의 samples 상한

const STATIC_EXT =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|txt|xml|webmanifest|json|mp4|webm|mp3|pdf)$/i;
const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|bingpreview|headlesschrome|curl\/|wget\/|python-requests|go-http-client|okhttp|scrapy|node-fetch|axios/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** 경로 종류 상한에 세지 않는 묶음 버킷 */
const RESERVED_KEYS = new Set(['(404)', '(other)']);

/* ------------------------------ 한 줄 해석 ------------------------------ */

/**
 * Caddy 접근 로그 한 줄(JSON) → 우리가 쓰는 모양. 접근 로그가 아니면 null.
 * 필드는 Caddy 기본 JSON 인코더의 것이다: ts(초, 소수) · duration(초, 소수) · status · request.{method,uri,headers}.
 */
export function parseAccessLine(line) {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  const req = j && j.request;
  if (!req || typeof req.uri !== 'string' || typeof j.status !== 'number') return null;

  const uri = req.uri.length > 2000 ? req.uri.slice(0, 2000) : req.uri;
  // 스캐너는 프록시용 절대 URI(GET http://x/) 도 보낸다 — 경로가 아니므로 한데 묶는다
  const p = uri.startsWith('/') ? uri.split('?')[0].slice(0, MAX_PATH_LEN) : '(non-path)';
  const ua = req.headers && req.headers['User-Agent'] && req.headers['User-Agent'][0];

  return {
    ts: typeof j.ts === 'number' ? j.ts * 1000 : Date.now(),
    method: String(req.method || 'GET').toUpperCase(),
    path: p,
    status: j.status,
    ms: typeof j.duration === 'number' ? j.duration * 1000 : 0,
    ua: typeof ua === 'string' ? ua : '',
  };
}

/** 숫자·UUID 세그먼트를 [id] 로 접고, 끝 슬래시를 떼고, 점을 '_' 로 바꾼다 (점은 지표 이름의 통계 구분자) */
export function normalizePath(p) {
  return p
    .replace(/\/\d+(?=\/|$)/g, '/[id]')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/[id]')
    .replace(/(.)\/+$/, '$1')
    .replace(/\./g, '_');
}

/** page · api · static · other. 404 는 경로가 뭐든 other — 스캐너 잡음이 페이지 수를 부풀리지 않게 한다 */
export function classify(rec) {
  const p = rec.path;
  if (p === '/api' || p.startsWith('/api/')) return 'api';
  if (!p.startsWith('/')) return 'other';
  if (p.startsWith('/_next/') || STATIC_EXT.test(p)) return 'static';
  if (rec.status === 404) return 'other';
  return 'page';
}

/**
 * 경로별 버킷 이름. 404 는 전부 '(404)' 하나로 — 스캐너가 /wp-login.php · /api/xyz 를 무작위로 두드려
 * 경로 종류 상한(MAX_KEYS)을 진짜 경로 대신 채우는 것을 막는다. 404 건수는 이 버킷과 edge.req.4xx 에 남는다.
 */
export function routeKey(rec) {
  if (rec.status === 404) return '(404)';
  if (!rec.path.startsWith('/')) return '(other)';
  const method = METHODS.has(rec.method) ? rec.method : '(other)';
  return `${method} ${normalizePath(rec.path)}`;
}

function trimKey(key) {
  return key.length > KEY_MAX_LEN ? key.slice(0, KEY_MAX_LEN - 1) + '…' : key;
}

function p95(samples) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

/* ------------------------------ 집계 창 ------------------------------ */

export class TrafficWindow {
  constructor(now = Date.now()) {
    this.reset(now);
  }

  reset(now = Date.now()) {
    this.start = now;
    this.total = 0;
    this.status = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.kinds = { page: 0, api: 0, static: 0, other: 0 };
    this.bots = 0;
    this.ms = [];
    /** @type {Map<string, { count: number, errors: number }>} */
    this.routes = new Map();
  }

  add(rec) {
    this.total += 1;
    const cls = `${Math.floor(rec.status / 100)}xx`;
    if (cls in this.status) this.status[cls] += 1;

    const kind = classify(rec);
    this.kinds[kind] += 1;
    if (!rec.ua || BOT_UA.test(rec.ua)) this.bots += 1;

    if (this.ms.length < MAX_SAMPLES) this.ms.push(rec.ms);
    else {
      const j = Math.floor(Math.random() * this.total);
      if (j < MAX_SAMPLES) this.ms[j] = rec.ms;
    }

    if (kind === 'static') return; // 정적 파일은 경로별로 세지 않는다 — 종류 합계로 충분하다
    let key = routeKey(rec);
    let b = this.routes.get(key);
    if (!b) {
      // (404) · (other) 는 상한과 무관하게 늘 쓸 수 있어야 한다 — 실제 경로가 상한을 채운 뒤에 처음 나온
      // 404 가 (other) 로 밀려 들어가면, 스캐너 404 가 어디에도 따로 안 잡힌다
      if (this.routes.size >= MAX_KEYS && !RESERVED_KEYS.has(key)) {
        key = '(other)';
        b = this.routes.get(key);
      }
      if (!b) {
        b = { count: 0, errors: 0 };
        this.routes.set(key, b);
      }
    }
    b.count += 1;
    if (rec.status >= 500) b.errors += 1;
  }

  /** 지금까지의 창을 읽기 좋은 모양으로. 창은 비우지 않는다 */
  stats(now = Date.now()) {
    const windowSec = Math.max(1, (now - this.start) / 1000);
    const perMin = (n) => (n * 60) / windowSec;
    return {
      windowSec,
      total: this.total,
      rpm: perMin(this.total),
      status: { ...this.status },
      kinds: { ...this.kinds },
      kindRpm: Object.fromEntries(Object.entries(this.kinds).map(([k, n]) => [k, perMin(n)])),
      bots: this.bots,
      botRpm: perMin(this.bots),
      p95Ms: p95(this.ms),
      routes: [...this.routes.entries()]
        .map(([key, b]) => ({ key, count: b.count, rpm: perMin(b.count), errors: b.errors }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /** 창을 지표 목록으로 바꾸고 비운다. 요청이 0건이어도 기본 지표는 전부 낸다 */
  snapshot(now = Date.now(), { logOk = true } = {}) {
    const stats = this.stats(now);
    const ts = new Date(now).toISOString();
    const samples = [];
    const push = (metric, value) => samples.push({ ts, metric, value: Math.round(value * 100) / 100 });

    push('edge.req.rpm', stats.rpm);
    push('edge.req.2xx', stats.status['2xx']);
    push('edge.req.3xx', stats.status['3xx']);
    push('edge.req.4xx', stats.status['4xx']);
    push('edge.req.5xx', stats.status['5xx']);
    push('edge.req.p95_ms', stats.p95Ms);
    for (const kind of ['page', 'api', 'static', 'other']) push(`edge.kind.${kind}.rpm`, stats.kindRpm[kind]);
    push('edge.bot.rpm', stats.botRpm);
    push('edge.log.ok', logOk ? 1 : 0);

    // 긴 키는 잘려서 서로 같아질 수 있다 — 같은 이름이 한 묶음에 두 번 실리지 않게 합친다
    const merged = new Map();
    for (const r of stats.routes) {
      const k = trimKey(r.key);
      const m = merged.get(k) || { rpm: 0, errors: 0 };
      m.rpm += r.rpm;
      m.errors += r.errors;
      merged.set(k, m);
    }
    for (const [k, m] of merged) {
      push(`edge.route.${k}.rpm`, m.rpm);
      push(`edge.route.${k}.5xx`, m.errors);
    }

    this.reset(now);
    return { samples, stats };
  }
}

/* ------------------------------ 로그 꼬리 읽기 ------------------------------ */

/**
 * 로그 파일을 tail -F 처럼 읽는다. poll() 은 지난번 이후 **완성된 줄**만 돌려준다.
 *  · 처음에는 파일 끝에서 시작한다 (과거 로그를 지금 창에 쏟아붓지 않는다). fromStart 로 바꿀 수 있다.
 *  · 회전(inode 가 바뀜)이나 잘림(크기가 줄어듦)을 알아채고 새 파일을 처음부터 읽는다.
 *  · 파일이 없거나 못 읽으면 ok=false 로 두고 계속 기다린다 — 예외로 죽지 않는다.
 */
export class LogTailer {
  constructor(file, { fromStart = false } = {}) {
    this.file = file;
    this.fromStart = fromStart;
    this.ino = null;
    this.pos = null;
    this.decoder = new StringDecoder('utf8');
    this.rest = '';
    this.ok = true;
    this.error = '';
  }

  poll() {
    let fd;
    try {
      const st = fs.statSync(this.file);
      if (this.ino !== null && (st.ino !== this.ino || st.size < this.pos)) {
        this.pos = 0;
        this.decoder = new StringDecoder('utf8');
        this.rest = '';
      }
      this.ino = st.ino;
      if (this.pos === null) this.pos = this.fromStart ? 0 : st.size;

      const lines = [];
      fd = fs.openSync(this.file, 'r');
      while (this.pos < st.size) {
        const len = Math.min(READ_CHUNK, st.size - this.pos);
        const buf = Buffer.allocUnsafe(len);
        const n = fs.readSync(fd, buf, 0, len, this.pos);
        if (n === 0) break;
        this.pos += n;
        this.rest += this.decoder.write(buf.subarray(0, n));
        const parts = this.rest.split('\n');
        this.rest = parts.pop();
        for (const p of parts) if (p) lines.push(p);
      }
      this.ok = true;
      this.error = '';
      return lines;
    } catch (err) {
      this.ok = false;
      this.error = err instanceof Error ? err.message : String(err);
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/* ------------------------------ Pulse 전송 ------------------------------ */

/**
 * lib/telemetry.ts 의 flush() 와 같은 프로토콜: POST {PULSE_API_URL}/api/v1/metrics, Bearer 키, {agentId, sentAt, samples}.
 * 실패하면 경고만 남기고 그 창의 집계를 버린다 — 여기서 쌓아 두면 Pulse 가 죽은 동안 메모리만 는다.
 */
export async function pushSamples(samples, { apiUrl, key, agentId, fetchImpl = fetch, now = Date.now() }) {
  const url = apiUrl.replace(/\/+$/, '') + '/api/v1/metrics';
  try {
    for (let i = 0; i < samples.length; i += PUSH_BATCH) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ agentId, sentAt: new Date(now).toISOString(), samples: samples.slice(i, i + PUSH_BATCH) }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.warn(`[traffic] Pulse 가 ${res.status} 를 돌려줌 — 이 창의 지표 ${samples.length}개는 버린다`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn('[traffic] Pulse 전송 실패 —', err instanceof Error ? err.message : err);
    return false;
  }
}

/* ------------------------------ 실행 ------------------------------ */

const fmt = (n, d = 1) => (Number.isInteger(n) ? String(n) : n.toFixed(d));

export function summaryLine(s) {
  const st = s.status;
  return (
    `[traffic] ${Math.round(s.windowSec)}초 · 요청 ${s.total} (${fmt(s.rpm)}/분) · ` +
    `2xx ${st['2xx']} 3xx ${st['3xx']} 4xx ${st['4xx']} 5xx ${st['5xx']} · p95 ${Math.round(s.p95Ms)}ms · ` +
    `페이지 ${s.kinds.page} api ${s.kinds.api} 정적 ${s.kinds.static} 기타 ${s.kinds.other} · 봇 ${s.bots}`
  );
}

function runDaemon(env = process.env) {
  const file = env.CADDY_LOG || '/var/log/caddy/arcade-finder.log';
  const apiUrl = env.PULSE_API_URL;
  const key = env.PULSE_EDGE_KEY;
  const agentId = env.PULSE_EDGE_AGENT_ID || 'arcade-finder-edge';
  const pulse = Boolean(apiUrl && key);

  const tail = new LogTailer(file);
  const win = new TrafficWindow();
  let lastOk = null;

  console.log(
    `[traffic] ${file} 를 읽습니다 · ` +
      (pulse ? `Pulse ${apiUrl} (agent ${agentId})` : 'Pulse 전송 꺼짐 (PULSE_API_URL · PULSE_EDGE_KEY 없음) — 요약만 로그로 남깁니다'),
  );

  const drain = () => {
    const lines = tail.poll();
    if (tail.ok !== lastOk) {
      lastOk = tail.ok;
      if (tail.ok) console.log('[traffic] 로그를 읽고 있습니다');
      else console.warn(`[traffic] 로그를 못 읽습니다 — ${tail.error} (caddy 사용자로 돌리거나 파일 권한을 확인하세요)`);
    }
    for (const line of lines) {
      const rec = parseAccessLine(line);
      if (rec) win.add(rec);
    }
  };

  setInterval(drain, POLL_MS);
  setInterval(() => {
    drain();
    const { samples, stats } = win.snapshot(Date.now(), { logOk: tail.ok });
    if (stats.total > 0) console.log(summaryLine(stats));
    if (pulse) void pushSamples(samples, { apiUrl, key, agentId });
  }, FLUSH_MS);
}

/** 남아 있는 로그 전체를 한 번 집계해 표로 찍는다 */
export function summarize(files) {
  const win = new TrafficWindow(0);
  const perMinute = new Map();
  let first = Infinity;
  let last = -Infinity;
  let bad = 0;

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const rec = parseAccessLine(line);
      if (!rec) {
        bad += 1;
        continue;
      }
      win.add(rec);
      first = Math.min(first, rec.ts);
      last = Math.max(last, rec.ts);
      const m = Math.floor(rec.ts / 60_000);
      perMinute.set(m, (perMinute.get(m) || 0) + 1);
    }
  }
  if (win.total === 0) return `요청이 없습니다 (읽은 줄 중 접근 로그가 아닌 것 ${bad}줄)`;

  // 창 길이 = 로그가 덮는 구간. 한 줄뿐이면 1초로 본다
  const spanMs = Math.max(1000, last - first);
  const s = win.stats(spanMs);
  const peak = [...perMinute.entries()].sort((a, b) => b[1] - a[1])[0];
  const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const pct = (n) => `${((n / s.total) * 100).toFixed(1)}%`;

  const out = [];
  out.push(`기간   ${iso(first)} ~ ${iso(last)} (${fmt(spanMs / 60_000)}분)`);
  out.push(`요청   ${s.total}건 · 평균 ${fmt(s.rpm)}/분 · 피크 ${peak[1]}/분 (${iso(peak[0] * 60_000).slice(11, 16)}Z) · p95 ${Math.round(s.p95Ms)}ms`);
  out.push(
    `상태   2xx ${s.status['2xx']} (${pct(s.status['2xx'])}) · 3xx ${s.status['3xx']} · 4xx ${s.status['4xx']} (${pct(s.status['4xx'])}) · 5xx ${s.status['5xx']} (${pct(s.status['5xx'])})`,
  );
  out.push(`종류   페이지 ${s.kinds.page} · api ${s.kinds.api} · 정적 ${s.kinds.static} · 기타 ${s.kinds.other}`);
  out.push(`봇     ${s.bots}건 (${pct(s.bots)}) — UA 기준 추정`);
  out.push('');
  out.push('경로별 상위 15 (정적 파일 제외)');
  for (const r of s.routes.slice(0, 15)) {
    out.push(`  ${String(r.count).padStart(7)}  ${pct(r.count).padStart(6)}  ${r.key}${r.errors ? `   ← 5xx ${r.errors}` : ''}`);
  }
  if (bad) out.push('', `(접근 로그가 아닌 줄 ${bad}개는 건너뛰었습니다)`);
  return out.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('사용법: node scripts/caddy-traffic.mjs            상주 (Pulse 로 보냄)\n        node scripts/caddy-traffic.mjs --summary [로그…]   남은 로그 한 번 집계');
  } else if (args.includes('--summary')) {
    const files = args.filter((a) => a !== '--summary');
    console.log(summarize(files.length ? files : [process.env.CADDY_LOG || '/var/log/caddy/arcade-finder.log']));
  } else {
    runDaemon();
  }
}
