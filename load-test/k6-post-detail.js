/**
 * k6 — 게시글 상세 한 곳만 때리는 부하. `GET /api/posts/:id`
 *
 * 왜 별도 스크립트인가: k6-read.js 는 6개 엔드포인트를 섞어 재므로 한 라우트의
 * 개선이 1/6 로 희석됩니다 (PERFORMANCE.md 2부 — 같은 이유로 요청당 쿼리 변화가
 * 혼합 벤치에서는 안 보였습니다). 상세 경로만 A/B 하려면 그것만 때려야 합니다.
 *
 * 실행 (반드시 프로덕션 빌드):
 *   k6 run -e BASE_URL=http://localhost:3100 -e VUS=200 -e DURATION=30s \
 *          -e SUMMARY=before-r1.json load-test/k6-post-detail.js
 *
 * 옵션(-e):
 *   BASE_URL  대상 (기본 http://localhost:3000)
 *   VUS       동시 사용자 (기본 200)
 *   DURATION  유지 시간 (기본 30s)
 *   VIEW      1 이면 ?view=1 — 실제 사용자 경로(조회수 +1)를 그대로 재현. 기본 1
 *   SLEEP     반복 사이 think time 초. 기본 0 (포화 측정)
 *   SUMMARY   요약 JSON 파일명. 라운드별로 다르게 줘야 덮어쓰지 않습니다
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const VIEW = (__ENV.VIEW ?? '1') === '1';
const THINK = Number(__ENV.SLEEP || 0);

export const options = {
  scenarios: {
    detail: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 200),
      duration: __ENV.DURATION || '30s',
      gracefulStop: '5s',
    },
  },
  // 임계값은 A/B 비교가 목적이라 실패율만 본다 — 200 VU 포화에서 지연은
  // 당연히 크고, 그 크기를 비교하는 것이 이 측정이다.
  thresholds: { http_req_failed: ['rate<0.01'] },
  summaryTrendStats: ['med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/** 실제로 존재하는 글 id (댓글·첨부가 섞인 상태 그대로) */
export function setup() {
  const res = http.get(`${BASE}/api/posts?limit=50`);
  const posts = res.json('posts') || [];
  const ids = posts.map((p) => p.id);
  if (ids.length === 0) throw new Error('글이 없습니다 — DB 확인');
  return { ids };
}

export default function (data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const q = VIEW ? '?commentOffset=0&view=1' : '?commentOffset=0';

  const res = http.get(`${BASE}/api/posts/${id}${q}`, { tags: { name: 'post-detail' } });

  check(res, {
    'status 200': (r) => r.status === 200,
    '본문 있음': (r) => {
      // 껍데기만 200 으로 돌아오는 것을 잡는다 — 상세는 post.body 가 있어야 한다.
      try {
        return typeof r.json('post.body') === 'string';
      } catch {
        return false;
      }
    },
  });

  if (THINK > 0) sleep(THINK);
}

/** 라운드별 요약을 파일로 남긴다 — 비교는 이 파일들로 한다 */
export function handleSummary(data) {
  const out = { stdout: '' };
  if (__ENV.SUMMARY) out[__ENV.SUMMARY] = JSON.stringify(data, null, 1);
  return out;
}
