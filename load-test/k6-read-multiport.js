/**
 * k6-read.js 의 **여러 포트** 판 — 프로세스 수 A/B 를 재는 데 씁니다.
 *
 * 왜 앞단 프록시를 두지 않는가: 이 머신에 nginx·caddy 가 없고, **Node 로 프록시를
 * 만들면 그게 단일 스레드라 지금 재려는 천장이 프록시로 그대로 옮겨옵니다.**
 * 클라이언트에서 VU 를 포트에 나누면 "프로세스를 늘리면 앱이 얼마나 받아내는가"
 * 만 남습니다 (PERFORMANCE.md 2부 §6).
 *
 * 사용:
 *   k6 run -q -e PORTS=3101-3108 -e SCENARIO=sat200 load-test/k6-read-multiport.js
 *   k6 run -q -e PORTS=3101      -e SCENARIO=load   load-test/k6-read-multiport.js
 *
 * ⚠ **`BASE` 를 상수로 계산하면 안 됩니다.** init 문맥에서 `__VU` 는 0 이라 포트가
 *   `undefined` 가 됩니다. 반드시 함수로 두어 iteration 안에서 정해지게 하세요 —
 *   실제로 한 번 당한 함정입니다 (PERFORMANCE.md 2부 §6).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

/** "3101-3108" 또는 "3101,3105" 또는 "3101" */
function parsePorts(raw) {
  const spec = raw || '3000';
  const dash = /^(\d+)-(\d+)$/.exec(spec);
  if (dash) {
    const [, from, to] = dash;
    const out = [];
    for (let p = Number(from); p <= Number(to); p++) out.push(p);
    return out;
  }
  return spec.split(',').map((s) => Number(s.trim()));
}

const PORTS = parsePorts(__ENV.PORTS);
const HOST = __ENV.HOST || 'localhost';

/** VU 를 포트에 고르게 나눕니다. **함수여야** 합니다 (위 경고) */
function base() {
  return `http://${HOST}:${PORTS[(__VU - 1) % PORTS.length]}`;
}

/**
 * `sat*` 는 **think time 이 없는 포화 시나리오**입니다. 천장을 재려면 사용자를
 * 흉내 내면 안 됩니다 — sleep 이 있으면 VU 가 쉬는 동안 서버가 놀아서, 서버 한계가
 * 아니라 "VU 수 ÷ 반복 시간" 을 재게 됩니다.
 */
const SCENARIOS = {
  smoke: { executor: 'constant-vus', vus: 2, duration: '1m', think: 1 },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 20 },
      { duration: '3m', target: 20 },
      { duration: '30s', target: 0 },
    ],
    think: 1,
  },
  sat50: { executor: 'constant-vus', vus: 50, duration: '90s', think: 0 },
  sat200: { executor: 'constant-vus', vus: 200, duration: '90s', think: 0 },
  sat400: { executor: 'constant-vus', vus: 400, duration: '90s', think: 0 },
};

const which = __ENV.SCENARIO || 'sat200';
// think 는 우리 것이라 k6 옵션에서 **빼내야** 합니다 — `think: undefined` 로 남겨 두면
// 키 자체가 직렬화되어 k6 가 `unknown field "think"` 로 거부합니다.
const { think: THINK, ...scenarioOpts } = SCENARIOS[which];

export const options = {
  scenarios: { [which]: scenarioOpts },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // 포화 시나리오는 임계치를 걸지 않습니다 — 천장을 재는 것이 목적이고,
  // 임계치 위반이 곧 실패로 읽히면 "얼마나 받아내나" 라는 질문이 흐려집니다.
  thresholds: THINK > 0 ? { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.01'] } : {},
};

export default function () {
  const BASE = base();
  const id = 1 + ((__ITER * 7) % 900);

  const responses = http.batch([
    ['GET', `${BASE}/api/arcades?q=${encodeURIComponent('게임')}`, null, { tags: { name: 'arcades-search' } }],
    ['GET', `${BASE}/api/arcades?lat=37.5665&lng=126.9780&radius=5`, null, { tags: { name: 'arcades-radius' } }],
    ['GET', `${BASE}/api/arcades/${id}`, null, { tags: { name: 'arcade-detail' } }],
    ['GET', `${BASE}/api/posts?limit=20`, null, { tags: { name: 'posts-list' } }],
    ['GET', `${BASE}/api/tier`, null, { tags: { name: 'tier' } }],
    ['GET', `${BASE}/api/machines`, null, { tags: { name: 'machines' } }],
  ]);

  for (const res of responses) {
    // 상세는 없는 id 면 404 가 정상입니다 — 그것까지 실패로 세면 안 됩니다.
    check(res, { '2xx/404': (r) => r.status === 200 || r.status === 404 });
  }

  if (THINK > 0) sleep(THINK);
}
