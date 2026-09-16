/**
 * k6 — 쓰기(변이) 부하. 1~4부가 한 번도 안 잰 쪽입니다.
 *
 * ─── 이 측정이 묻는 것 ───────────────────────────────────────
 * 쓰기는 **양이 문제가 아닙니다.** 목표 규모에서 하루 1,245건, 피크 0.062 writes/s
 * 이고 읽기와 54:1 입니다(load-test/capacity-model.mjs). 그래서 "몇 건 받아내나" 는
 * 물을 가치가 없습니다. 대신 둘을 봅니다.
 *
 *   ① **요청 하나가 DB 를 몇 번 왕복하나** — 읽기는 3부에서 1회까지 줄였는데
 *      제보 등록은 손댄 적이 없습니다. 왕복이 곧 슬롯 점유입니다(2부 5절).
 *   ② **같은 오락실에 몰릴 때 버티나** — 대회·신작 입고 직후에 실제로 생기는
 *      패턴입니다. createReport 는 트랜잭션 안에서 applyPresence 를 돌리고,
 *      그게 `arcade_machines` 의 **같은 행**을 INSERT/DELETE 합니다. 동시에
 *      들어오면 직렬화되거나, 최악에는 집계가 어긋납니다.
 *
 * ─── 시나리오 ───────────────────────────────────────────────
 *   mix      쓰기 믹스를 측정 가능한 속도로 (기본 2/s = 피크의 32배)
 *            — 포화 탐색이 아니라 **쓰기 1건의 값**을 재려는 것입니다
 *   hotspot  한 오락실·한 기종에 제보 집중 (대회 직후)
 *
 * ─── 실행 ───────────────────────────────────────────────────
 * ⚠ **반드시 스케일 DB 를 보는 서버에** 거세요. 이 스크립트는 진짜로 씁니다.
 *
 *   DATABASE_URL="...arcade_finder_scale" npm run start:cluster
 *   k6 run -q -e BASE_URL=http://localhost:3000 -e SCENARIO=mix     load-test/k6-write.js
 *   k6 run -q -e BASE_URL=http://localhost:3000 -e SCENARIO=hotspot load-test/k6-write.js
 *
 * 옵션(-e): RATE(mix 의 writes/s) · VUS(hotspot 동시 수) · DURATION
 *
 * ─── 이제 모든 쓰기가 세션을 요구합니다 ──────────────────────
 * R1(신원을 세션 쿠키로) 이후 본문의 `playerId` 는 아무 의미가 없습니다. 그래서
 * **VU 마다 계정을 하나 만들어**(ensureSession) 그 쿠키로 씁니다. VU 가 서로
 * 다른 사람이라는 점이 오히려 측정에 맞습니다 — applyPresence 의 임계값은
 * `COUNT(DISTINCT player_id) >= 2` 라서 한 사람만으로는 가장 무거운 경로가
 * 아예 안 돌아갑니다.
 *
 * 세션이 안 서면 **그 자리에서 멈춥니다**(rejected_writes 에 `no-session`).
 * 401 을 잔뜩 세면서 "쓰기를 쟀다" 고 말하지 않기 위해서입니다.
 *
 * 참고: 운영 빌드(`next start`)의 세션 쿠키에는 `Secure` 가 붙는데, **k6 의 쿠키
 * 항아리는 그 속성을 무시**하고 평문 HTTP 로도 그대로 보냅니다(브라우저는 안
 * 보냅니다). 확인했습니다 — 클러스터(운영 빌드) 상대로 가입 201 → 세션 200 →
 * 즐겨찾기 200. 그래서 https 없이도 잴 수 있습니다. 뒤집어 말하면 **이 하네스가
 * 통과한다고 브라우저에서 되는 것은 아닙니다** — 그쪽은 https 가 필요합니다.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * **기대 상태코드를 k6 에 알려 줍니다.**
 *
 * 이걸 안 하면 `http_req_failed` 가 2xx 아닌 것을 전부 실패로 셉니다. 이 앱의
 * 쓰기에는 **정상적인 비-2xx 가 섞입니다** — 리뷰는 1인 1오락실이라 두 번째가
 * 409 이고, 제보는 그 사이 보유 기종이 바뀌면 409 입니다. 그걸 실패로 세면
 * 실패율이 30% 로 나오고(실제로 그렇게 나왔습니다), 진짜 5xx 가 묻힙니다.
 *
 * 401 은 **일부러 뺐습니다.** 즐겨찾기가 401 이면 로그인이 안 된 것이고,
 * 그건 측정이 그 경로를 안 탔다는 뜻이라 실패로 잡혀야 합니다.
 */
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Accept-Encoding': 'br, gzip' };

const SCENARIOS = {
  /**
   * 쓰기 믹스. 도착률을 피크(0.062/s)로 두면 3분에 11건이라 분포가 안 나옵니다.
   * **무엇을 재는지가 다릅니다** — 여기서는 포화가 아니라 건당 비용을 봅니다.
   */
  mix: {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.RATE || 2),
    timeUnit: '1s',
    duration: __ENV.DURATION || '2m',
    preAllocatedVUs: 20,
    maxVUs: 60,
  },
  /**
   * 쏠림. 도착률이 아니라 **동시성**이 변수라 VU 고정입니다 — 같은 행을 동시에
   * 건드리는 트랜잭션이 몇 개나 겹치는지가 이 측정의 전부입니다.
   */
  hotspot: {
    executor: 'constant-vus',
    vus: Number(__ENV.VUS || 20),
    duration: __ENV.DURATION || '90s',
  },
};

const which = __ENV.SCENARIO || 'mix';

export const options = {
  scenarios: { [which]: SCENARIOS[which] },
  thresholds: {
    // 쓰기는 읽기보다 느린 게 정상입니다. 다만 **실패는 0 이어야** 합니다 —
    // 경합으로 5xx 가 나오면 그건 성능이 아니라 버그입니다.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    'http_req_duration{name:report-presence}': ['p(95)<1000'],
    'http_req_duration{name:report-absence}': ['p(95)<1000'],
    'http_req_duration{name:report-queue}': ['p(95)<1000'],
    'http_req_duration{name:report-condition}': ['p(95)<1000'],
    'http_req_duration{name:review}': ['p(95)<1000'],
    'http_req_duration{name:post-like}': ['p(95)<1000'],
    // 임계값을 걸어 둔 이름만 하위 지표가 생깁니다 — 여기 없으면 요약의
    // "엔드포인트별 p95" 에서도 조용히 빠집니다.
    'http_req_duration{name:favorite}': ['p(95)<1000'],
  },
  // 'count' 가 있어야 요약에서 표본 수를 볼 수 있습니다 — summaryTrendStats 에
  // 없는 통계는 handleSummary 에도 안 실립니다.
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

/** 기대한 상태코드가 아닌 응답 — 본문을 한 번만 찍어 원인을 남깁니다 */
const rejected = new Counter('rejected_writes');
let loggedOnce = false;

function expect(res, name, okCodes) {
  const ok = okCodes.includes(res.status);
  if (!ok) {
    // 어느 엔드포인트가 어떤 코드로 거절됐는지 — 총합만 보면 원인을 못 찾습니다
    // (실제로 한참 헤맸습니다).
    rejected.add(1, { name, status: String(res.status) });
    if (!loggedOnce) {
      loggedOnce = true;
      console.error(`[${name}] ${res.status} — ${String(res.body).slice(0, 300)}`);
    }
  }
  check(res, { [`${name} 성공`]: () => ok });
  return ok;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * VU 마다 세션을 하나 만들고, **쿠키 값을 직접 들고 다닙니다.**
 *
 * ─── 예전에 못 찾았던 401 의 원인 ───────────────────────────
 * k6 의 기본 쿠키 항아리는 VU 별인데 **반복(iteration)마다 초기화됩니다.**
 * 그래서 가입 때 받은 세션이 다음 반복에서 사라지는데, "세션을 세웠다" 는
 * 모듈 변수는 그대로 남아 있어 **없는 세션을 있다고 믿고** 쓰기를 던집니다.
 * 즐겨찾기가 "VU 1개면 되는데 동시 VU 면 일부가 401" 이던 것이 이것입니다 —
 * 동시성 문제가 아니라 **반복 2회차부터 전부 401** 이었습니다.
 *
 * 그래서 항아리에 맡기지 않고 쿠키 문자열을 모듈 변수에 담아 헤더로 직접
 * 싣습니다. 초기화되든 말든 상관없어집니다.
 *
 * ⚠ **로그인이 아니라 가입으로 세션을 얻습니다.** `/api/auth/login` 이
 * `ADMIN_PASSWORD` 미설정 환경에서는 **일반 사용자에게도 503** 을 돌려주기
 * 때문입니다 (관리자 전용이던 시절의 가드가 라우트 전체를 막습니다 —
 * PERFORMANCE.md 17절). 가입은 세션 쿠키를 직접 심으므로 여기서는 그쪽을 씁니다.
 */
let sessionTried = false;
/** `arcade_session=…` — 이 VU 가 계속 쓰는 신원 */
let sessionCookie = null;

/** 쓰기 요청의 공통 파라미터 — 신원을 반드시 싣습니다 */
const authed = (name) => ({
  headers: { ...JSON_HEADERS, Cookie: sessionCookie },
  tags: { name },
});

function ensureSession() {
  if (sessionTried) return sessionCookie !== null;
  sessionTried = true;

  const creds = {
    nickname: `wr${__VU}x${Date.now().toString(36)}`,
    password: 'loadtest-pw-1234',
    passwordConfirm: 'loadtest-pw-1234',
  };
  const res = http.post(`${BASE}/api/auth/signup`, JSON.stringify(creds), {
    headers: JSON_HEADERS,
    tags: { name: 'signup' },
  });
  if (![200, 201].includes(res.status)) return false;

  const stored = http.cookieJar().cookiesForURL(`${BASE}/`)['arcade_session'];
  if (!stored || !stored.length) return false;
  sessionCookie = `arcade_session=${stored[0]}`;

  /**
   * 헤더로 직접 실어도 서버가 알아보는지 한 번 확인합니다. 응답 키는 `user`
   * 입니다 — `player` 로 물으면 없는 키가 undefined 로 와서 `!= null` 이 참이
   * 되어 **세션이 있다고 착각합니다** (실제로 한 번 당했습니다).
   */
  if (http.get(`${BASE}/api/auth/session`, { headers: { Cookie: sessionCookie } }).json('user') == null) {
    sessionCookie = null;
    return false;
  }
  return true;
}

export function setup() {
  const arcades = http.get(`${BASE}/api/arcades`).json('arcades') || [];
  const posts = http.get(`${BASE}/api/posts?limit=50`).json('posts') || [];

  if (!arcades.length) throw new Error('오락실이 없습니다 — 스케일 DB 를 보고 있는지 확인');
  if (!posts.length) throw new Error('글이 없습니다');
  if (posts.length < 10) throw new Error('글이 적습니다 — seed-scale.sql 을 돌렸는지 확인');

  /**
   * 누가 쓰는지는 여기서 정하지 않습니다 — VU 가 각자 가입해서 자기 쿠키로
   * 씁니다(ensureSession). applyPresence 의 임계값이
   * `COUNT(DISTINCT player_id) >= 2` 라서 **서로 다른 사람**이어야 하는데,
   * VU 가 곧 서로 다른 사람입니다. hotspot 은 VUS(기본 20)이 그 수입니다.
   */
  // 기체가 있는 조합(대기·컨디션 제보가 가능) / 없는 기종(있어요 제보로 추가되는 쪽)
  const withMachine = [];
  for (const a of arcades) {
    for (const m of a.machines ?? []) {
      const cab = (m.cabinets ?? [])[0];
      if (cab) withMachine.push({ arcadeId: a.id, machineId: m.id, cabinetId: cab.id });
      if (withMachine.length >= 300) break;
    }
    if (withMachine.length >= 300) break;
  }
  if (!withMachine.length) throw new Error('보유 기종이 있는 오락실이 없습니다');

  // 쏠림 대상 — 한 곳을 고정합니다.
  const hot = withMachine[0];

  return {
    postIds: posts.map((p) => p.id),
    arcadeIds: arcades.slice(0, 300).map((a) => a.id),
    withMachine,
    hot,
  };
}

/** 제보 — 이 앱에서 가장 무거운 쓰기 (트랜잭션 + applyPresence + 피드 재조회) */
function report(target, kind, name) {
  const body = { machineId: target.machineId, kind };
  if (kind === 'queue') body.waitCount = Math.floor(Math.random() * 13);
  if (kind === 'condition') {
    body.condition = 1 + Math.floor(Math.random() * 5);
    body.cabinetId = target.cabinetId;
  }
  const res = http.post(
    `${BASE}/api/arcades/${target.arcadeId}/reports`,
    JSON.stringify(body),
    authed(name),
  );
  // 409 = "그 사이 보유 기종이 바뀌었다" — 쏠림 중에는 정상적으로 나올 수 있습니다.
  expect(res, name, [201, 409]);
}

export default function (data) {
  // 세션이 없으면 재지 않습니다 — 401 은 "쓰기가 느리다" 가 아니라
  // "측정이 그 경로를 안 탔다" 는 뜻입니다.
  if (!ensureSession()) {
    rejected.add(1, { name: 'no-session', status: '0' });
    sleep(1);
    return;
  }
  if (which === 'hotspot') return hotspot(data);
  return mix(data);
}

/**
 * 쏠림 — 모두가 **같은 오락실·같은 기종**에 있어요/없어졌어요를 던집니다.
 * 서로 다른 플레이어라 임계값(2명)이 계속 차고, 그때마다 applyPresence 가
 * `arcade_machines` 의 같은 행을 INSERT/DELETE 합니다. 여기가 직렬화 지점입니다.
 */
function hotspot(data) {
  // 있어요 7 : 없어졌어요 3 — 추가와 삭제가 번갈아 일어나야 경합이 드러납니다.
  const kind = Math.random() < 0.7 ? 'presence' : 'absence';
  report(data.hot, kind, `report-${kind}`);
  sleep(0.2);
}

/** 평시 쓰기 믹스 — 비중은 capacity-model.mjs 의 WRITE_MIX 를 따릅니다 */
function mix(data) {
  /**
   * 비중은 WRITE_MIX(capacity-model.mjs)에서 이 네 가지만 뽑아 다시 나눕니다 —
   * 제보 210 · 추천 250 · 리뷰 15 · 즐겨찾기 150 (하루) → 34 : 40 : 2.4 : 24.
   *
   * **리뷰만 10% 로 올려 둡니다.** 모델대로 2.4% 면 2분에 6건이라 p95 가
   * 숫자놀음이 됩니다. 대신 믹스가 그만큼 리뷰 쪽으로 기울어 있다는 것을
   * 알고 읽어야 합니다 — 리뷰는 UPSERT 한 번이라 제보보다 가볍습니다.
   */
  const r = Math.random();

  if (r < 0.31) {
    // 제보 — 종류를 섞습니다 (대기가 가장 흔합니다)
    const target = pick(data.withMachine);
    const k = Math.random();
    if (k < 0.5) report(target, 'queue', 'report-queue');
    else if (k < 0.8) report(target, 'condition', 'report-condition');
    else report(target, 'presence', 'report-presence');
    return;
  }

  if (r < 0.68) {
    /**
     * 글 추천. 토글이 아니라 `PUT`(켜기)·`DELETE`(끄기)입니다 — 멱등하게
     * 바꿨기 때문입니다(app/api/posts/[id]/like 주석). 절반씩 보내 INSERT 와
     * DELETE 를 모두 태웁니다. 어느 쪽이든 like_count 를 다시 세므로 같은 글에
     * 몰리면 행 경합이 생깁니다.
     */
    const postId = pick(data.postIds);
    const res =
      Math.random() < 0.5
        ? http.put(`${BASE}/api/posts/${postId}/like`, JSON.stringify({}), authed('post-like'))
        : http.del(`${BASE}/api/posts/${postId}/like`, null, authed('post-like'));
    expect(res, 'post-like', [200]);
    return;
  }

  if (r < 0.78) {
    // 리뷰 — 1인 1오락실이라 이미 쓴 조합이면 409 가 정상입니다
    const res = http.post(
      `${BASE}/api/arcades/${pick(data.arcadeIds)}/reviews`,
      JSON.stringify({ rating: 1 + Math.floor(Math.random() * 5), body: '부하 테스트' }),
      authed('review'),
    );
    expect(res, 'review', [200, 201, 409]);
    return;
  }

  /**
   * 즐겨찾기 — 세션이 근거인 쓰기입니다. 예전에는 하네스가 세션을 못 세워
   * 빼 뒀는데, R1 이후에는 어차피 모든 쓰기가 세션을 쓰므로 같이 잽니다.
   * 켜기/끄기를 번갈아 INSERT·DELETE 를 태웁니다.
   */
  const arcadeId = pick(data.arcadeIds);
  const res =
    Math.random() < 0.5
      ? http.put(`${BASE}/api/favorites`, JSON.stringify({ arcadeId }), authed('favorite'))
      : http.del(`${BASE}/api/favorites?arcadeId=${arcadeId}`, null, authed('favorite'));
  expect(res, 'favorite', [200]);
}


export function handleSummary(data) {
  const m = data.metrics;
  const num = (v, d = 1) => (v === undefined ? '—' : Number(v).toFixed(d));
  const dur = m.http_req_duration?.values ?? {};
  const reqs = m.http_reqs?.values ?? {};
  const failed = m.http_req_failed?.values ?? {};

  const lines = [
    '',
    `시나리오            ${which}   (${__ENV.LABEL || '—'})`,
    `쓰기 처리량         ${num(reqs.rate, 2)} writes/s   (총 ${reqs.count ?? 0}건)`,
    `지연  중앙값        ${num(dur.med, 1)} ms`,
    `      p95           ${num(dur['p(95)'], 1)} ms`,
    `      p99           ${num(dur['p(99)'], 1)} ms`,
    `      최대          ${num(dur.max, 1)} ms`,
    `실패율              ${num((failed.rate ?? 0) * 100, 3)} %`,
    `거절된 쓰기         ${m.rejected_writes?.values?.count ?? 0} 건`,
    '',
    '엔드포인트별 p95 (ms)',
  ];

  const byName = {};
  for (const [key, metric] of Object.entries(m)) {
    if (!key.startsWith('rejected_writes{')) continue;
    byName[key.slice('rejected_writes{'.length, -1)] = metric.values?.count ?? 0;
  }

  for (const [key, metric] of Object.entries(m)) {
    if (!key.startsWith('http_req_duration{name:')) continue;
    // 안 돈 경로는 빼 둡니다. 표본 0 을 "p95 0.0ms" 로 찍으면 가장 빠른
    // 엔드포인트처럼 읽힙니다 (시나리오마다 도는 경로가 다릅니다).
    if (!(metric.values?.count > 0)) continue;
    const name = key.slice('http_req_duration{name:'.length, -1);
    lines.push(
      `  ${name.padEnd(18, ' ')} ${num(metric.values?.['p(95)'], 1).padStart(8)}` +
        `   (${metric.values.count}건)`,
    );
  }

  const rejectedRows = Object.entries(byName).filter(([, v]) => v > 0);
  if (rejectedRows.length) {
    lines.push('', '거절 내역 (엔드포인트 · 상태코드)');
    for (const [k, v] of rejectedRows) lines.push(`  ${k.padEnd(40, ' ')} ${String(v).padStart(5)}`);
  }

  const fails = Object.entries(m)
    .flatMap(([key, metric]) =>
      Object.entries(metric.thresholds ?? {})
        .filter(([, t]) => !t.ok)
        .map(([expr]) => `  ✗ ${key}  ${expr}`))
    .join('\n');
  lines.push('', fails ? `임계값 위반\n${fails}` : '임계값  전부 통과 ✓', '');

  const out = { stdout: lines.join('\n') };
  if (__ENV.SUMMARY) out[__ENV.SUMMARY] = JSON.stringify(data, null, 1);
  return out;
}
