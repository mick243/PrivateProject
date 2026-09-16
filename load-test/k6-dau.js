/**
 * k6 — 가입자 10,000 · DAU 3,000 기준 부하
 *
 * 기존 k6-read.js 와 다른 점 두 가지입니다.
 *
 * ① **닫힌 모델(VU)이 아니라 열린 모델(arrival-rate)** 입니다.
 *    "200 VU" 는 서버가 느려지면 부하도 같이 느려져서, 목표 처리량을 정해 놓고
 *    "그걸 견디나" 를 묻는 데는 못 씁니다. 우리는 이제 목표 rps 를 압니다
 *    (load-test/capacity-model.mjs). 그러면 초당 도착률을 고정하고 지연을 봐야 합니다.
 *
 * ② **한 반복 = 한 세션** 입니다. 기존 스크립트는 6개 엔드포인트를 http.batch 로
 *    동시에 때렸는데, 실제 사용자는 한 페이지에 머물다 다음 페이지로 갑니다.
 *    (PERFORMANCE.md 1부 '남은 것' 이 지적한 그 문제입니다.)
 *    여기서는 브라우저로 실측한 요청 순서를 그대로 따라갑니다.
 *
 * 실행 (반드시 프로덕션 빌드):
 *   k6 run -e SCENARIO=peak   load-test/k6-dau.js   # 평시 피크 (DAU 3,000)
 *   k6 run -e SCENARIO=burst  load-test/k6-dau.js   # 순간 3배
 *   k6 run -e SCENARIO=growth load-test/k6-dau.js   # 10배 (DAU 30,000 상당)
 *   k6 run -e SCENARIO=ceiling load-test/k6-dau.js  # 어디서 무너지나
 *
 * 옵션(-e): BASE_URL · SUMMARY(요약 JSON 파일) · THINK(0 이면 think time 제거)
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const THINK = __ENV.THINK === '0' ? 0 : 1;

/**
 * capacity-model.mjs 의 도출값. k6 는 import 를 못 하므로 손으로 옮겨 적되,
 * 바뀌면 여기도 같이 고쳐야 합니다 — 모델을 돌려 나온 '세션/s' 를 넣으세요.
 *   평시 0.225/s · 버스트 0.675/s · 성장 2.25/s
 */
const SESSIONS_PER_SEC = { peak: 0.225, burst: 0.675, growth: 2.25 };

/**
 * k6 의 `rate` 는 정수만 받습니다. 0.225 세션/s 는 분당 13.5 라 소수가 되므로
 * **시간당**으로 적습니다 — 어차피 모델이 "피크아워 810세션" 에서 나온 값이라
 * 이쪽이 원래 단위에 더 가깝습니다.
 */
const perHour = (rps) => Math.round(rps * 3600);

/** 세션 하나가 think time 포함 ~40초 걸리므로 VU 를 넉넉히 잡아 둡니다 */
const vusFor = (rps) => Math.max(10, Math.ceil(rps * 60 * 2));

const SCENARIOS = {
  // 평시 피크 — 저녁 21~23시 (810 세션/h)
  peak: {
    executor: 'constant-arrival-rate',
    rate: perHour(SESSIONS_PER_SEC.peak),
    timeUnit: '1h',
    duration: '5m',
    preAllocatedVUs: vusFor(SESSIONS_PER_SEC.peak),
    maxVUs: 60,
  },
  // 순간 3배 — 대회·입고 공지 직후
  burst: {
    executor: 'constant-arrival-rate',
    rate: perHour(SESSIONS_PER_SEC.burst),
    timeUnit: '1h',
    duration: '3m',
    preAllocatedVUs: vusFor(SESSIONS_PER_SEC.burst),
    maxVUs: 120,
  },
  // 성장 헤드룸 — DAU 30,000 이 되어도 구성을 안 바꾸고 버티나
  growth: {
    executor: 'constant-arrival-rate',
    rate: perHour(SESSIONS_PER_SEC.growth),
    timeUnit: '1h',
    duration: '3m',
    preAllocatedVUs: vusFor(SESSIONS_PER_SEC.growth),
    maxVUs: 400,
  },
  // 천장 탐색 — 도착률을 계단으로 올려 어디서 SLO 를 깨는지
  ceiling: {
    executor: 'ramping-arrival-rate',
    startRate: 60,
    timeUnit: '1m',
    preAllocatedVUs: 100,
    maxVUs: 900,
    stages: [
      { duration: '1m', target: 120 },   // 세션 2/s   (DAU 27,000)
      { duration: '1m', target: 300 },   // 세션 5/s   (DAU 67,000)
      { duration: '1m', target: 600 },   // 세션 10/s  (DAU 133,000)
      { duration: '1m', target: 1200 },  // 세션 20/s  (DAU 267,000)
    ],
  },
};

const which = __ENV.SCENARIO || 'peak';

export const options = {
  scenarios: { [which]: SCENARIOS[which] },
  /**
   * SLO — 목표 부하가 정해졌으니 임계값도 목표에 맞춥니다.
   * 기존 p95 < 500ms 는 200 VU 포화를 전제로 한 값이라 평시 피크에서는 너무 헐렁합니다.
   */
  thresholds: {
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    // 첫 화면을 좌우하는 두 요청은 더 빡빡하게 본다
    'http_req_duration{name:arcades-full}': ['p(95)<300'],
    'http_req_duration{name:posts-list}': ['p(95)<150'],
    // 아래는 임계값이 목적이 아니라 **엔드포인트별 p95 를 보기 위한** 선언입니다.
    // k6 는 임계값이 걸린 태그에만 서브메트릭을 만들어 줍니다.
    'http_req_duration{name:session}': ['p(95)<2000'],
    'http_req_duration{name:machines}': ['p(95)<2000'],
    'http_req_duration{name:arcade-reports}': ['p(95)<2000'],
    'http_req_duration{name:arcade-reviews}': ['p(95)<2000'],
    'http_req_duration{name:boards}': ['p(95)<2000'],
    'http_req_duration{name:post-detail}': ['p(95)<2000'],
    'http_req_duration{name:tier}': ['p(95)<2000'],
    'http_req_duration{name:live-feed}': ['p(95)<2000'],
    'http_req_duration{name:live-poll}': ['p(95)<2000'],
    // 도착률을 못 채우면(= VU 부족/서버 지연) 측정 자체가 무효다
    dropped_iterations: ['count<5'],
  },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/** 세션 하나가 받은 바이트 — 대역폭 비용 산정용 */
const sessionBytes = new Counter('session_bytes');

export function setup() {
  const arcades = http.get(`${BASE}/api/arcades`).json('arcades') || [];
  const posts = http.get(`${BASE}/api/posts?limit=50`).json('posts') || [];
  if (!arcades.length) throw new Error('오락실 데이터가 없습니다 — DB 확인');
  if (!posts.length) throw new Error('글이 없습니다 — DB 확인');
  return {
    arcadeIds: arcades.slice(0, 200).map((a) => a.id),
    postIds: posts.map((p) => p.id),
  };
}

/**
 * **브라우저가 실제로 보내는 헤더를 흉내냅니다.**
 *
 * k6 는 기본으로 `Accept-Encoding` 을 안 보냅니다. 그래서 이 헤더 없이 재면
 * 서버의 응답 압축(lib/http.ts)이 아예 발동하지 않고, `data_received` 가 압축
 * 전 크기로 잡힙니다 — 실제로 한 번 당했습니다(세션당 1,281KB 가 그대로 나옴).
 * 대역폭이 이 서비스의 주된 비용이므로 이 한 줄이 측정의 전제입니다.
 */
const HEADERS = { 'Accept-Encoding': 'br, gzip' };

/** 모든 요청이 같은 헤더를 쓰도록 한 곳을 지나가게 합니다. */
const get = (url, name) => http.get(url, { headers: HEADERS, tags: { name } });

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const think = (s) => { if (THINK) sleep(s); };

function tally(responses) {
  let bytes = 0;
  for (const res of responses) {
    bytes += Number(res.headers['Content-Length'] || res.body?.length || 0);
    check(res, { 'status 200': (r) => r.status === 200 });
  }
  sessionBytes.add(bytes);
}

/**
 * 한 세션의 실제 경로. 브라우저로 센 순서 그대로입니다 (2026-09-11).
 * 페이지 진입마다 /api/auth/session 이 한 번씩 붙는 것도 실제 동작입니다.
 */
export default function (data) {
  group('홈 — 지도·목록', () => {
    tally([
      get(`${BASE}/api/auth/session`, 'session'),
      get(`${BASE}/api/machines`, 'machines'),
      // 목록 전체를 한 번에 받습니다 — 목표 규모 데이터에서 무압축 1.2MB,
      // 압축하면 90KB. 이 한 줄이 세션 대역폭의 대부분입니다.
      get(`${BASE}/api/arcades`, 'arcades-full'),
    ]);
  });
  think(3);

  group('오락실 상세 ×2', () => {
    for (let i = 0; i < 2; i += 1) {
      const id = pick(data.arcadeIds);
      tally([
        get(`${BASE}/api/arcades/${id}/reports?limit=20`, 'arcade-reports'),
        get(`${BASE}/api/arcades/${id}/reviews`, 'arcade-reviews'),
      ]);
      think(2);
    }
  });

  group('커뮤니티', () => {
    tally([
      get(`${BASE}/api/auth/session`, 'session'),
      get(`${BASE}/api/boards`, 'boards'),
      get(`${BASE}/api/posts?sort=recent&limit=20&offset=0`, 'posts-list'),
    ]);
    think(3);
    // 목록을 본 사람의 일부만 글을 엽니다 (1.5회/세션 ≈ 75%)
    if (Math.random() < 0.75) {
      const id = pick(data.postIds);
      tally([get(`${BASE}/api/posts/${id}?commentOffset=0&view=1`, 'post-detail')]);
      think(4);
    }
  });

  group('서열표', () => {
    tally([
      get(`${BASE}/api/auth/session`, 'session'),
      get(`${BASE}/api/tier`, 'tier'),
    ]);
  });
  think(2);

  // 세션의 20% 는 /live 를 열어 두고 30초마다 자동 갱신을 받습니다.
  // 이 경로는 읽을 때마다 만료 제보를 DELETE 하므로, 읽기지만 쓰기입니다.
  if (Math.random() < 0.2) {
    group('/live 피드 + 폴링', () => {
      tally([
        get(`${BASE}/api/reports?limit=80&sinceHours=24`, 'live-feed'),
      ]);
      think(THINK ? 30 : 0);
      tally([
        get(`${BASE}/api/reports?limit=80&sinceHours=24`, 'live-poll'),
      ]);
    });
  }
}

/**
 * 요약을 직접 씁니다. k6 는 handleSummary 를 내보내는 순간 기본 요약을 끄는데,
 * 기본 요약은 라운드를 여러 번 돌릴 때 읽을 게 너무 많습니다. 판단에 쓰는 줄만 남깁니다.
 */
export function handleSummary(data) {
  const m = data.metrics;
  const num = (v, d = 1) => (v === undefined ? '—' : Number(v).toFixed(d));
  const dur = m.http_req_duration?.values ?? {};
  const reqs = m.http_reqs?.values ?? {};
  const failed = m.http_req_failed?.values ?? {};
  const iters = m.iterations?.values ?? {};
  const dropped = m.dropped_iterations?.values?.count ?? 0;
  const recv = m.data_received?.values ?? {};

  const lines = [
    '',
    `시나리오            ${__ENV.SCENARIO || 'peak'}   (풀 ${__ENV.POOL_LABEL || '?'} · 프로세스 ${__ENV.PROC_LABEL || '?'})`,
    `처리량              ${num(reqs.rate, 1)} req/s   (세션 ${num(iters.rate, 3)}/s · 완료 ${iters.count ?? 0})`,
    `지연  중앙값        ${num(dur.med, 1)} ms`,
    `      p95           ${num(dur['p(95)'], 1)} ms`,
    `      p99           ${num(dur['p(99)'], 1)} ms`,
    `      최대          ${num(dur.max, 1)} ms`,
    `실패율              ${num((failed.rate ?? 0) * 100, 3)} %   (버려진 반복 ${dropped})`,
    `수신                ${num((recv.count ?? 0) / 1024 / 1024, 1)} MB   (세션당 ${num((recv.count ?? 0) / Math.max(1, iters.count ?? 1) / 1024, 1)} KB)`,
    '',
    '엔드포인트별 p95 (ms)',
  ];

  for (const [key, metric] of Object.entries(m)) {
    if (!key.startsWith('http_req_duration{name:')) continue;
    const name = key.slice('http_req_duration{name:'.length, -1);
    lines.push(`  ${name.padEnd(18, ' ')} ${num(metric.values?.['p(95)'], 1).padStart(8)}`);
  }

  const thresholdFails = Object.entries(m)
    .flatMap(([key, metric]) =>
      Object.entries(metric.thresholds ?? {})
        .filter(([, t]) => !t.ok)
        .map(([expr]) => `  ✗ ${key}  ${expr}`))
    .join('\n');
  lines.push('', thresholdFails ? `임계값 위반\n${thresholdFails}` : '임계값  전부 통과 ✓', '');

  const out = { stdout: lines.join('\n') };
  if (__ENV.SUMMARY) out[__ENV.SUMMARY] = JSON.stringify(data, null, 1);
  return out;
}
