/**
 * 용량 모델 — 가입자 10,000 · DAU 3,000 을 요청/초로 옮깁니다.
 *
 * 왜 이 파일이 있나: 지금까지의 부하테스트는 "200 VU" 처럼 **목표 없는 숫자**를
 * 기준으로 잡혀 있었습니다. 200 VU 가 우리 서비스에서 몇 명인지 아무도 몰랐고,
 * 그래서 8프로세스·풀 88 같은 구성이 필요한지 과한지 판단할 근거가 없었습니다.
 * 이 파일이 그 근거입니다 — 가입자 수에서 출발해 피크 RPS 와 동시 사용자까지
 * 한 줄씩 계산하고, k6 시나리오(k6-dau.js)가 이 숫자를 그대로 읽어 씁니다.
 *
 * 숫자를 바꾸고 싶으면 아래 ASSUMPTIONS 만 고치세요. k6 와 문서가 같이 따라옵니다.
 *
 *   node load-test/capacity-model.mjs        # 계산 결과를 표로 출력
 *   node load-test/capacity-model.mjs --json # 기계가 읽을 형태로
 */

/** 바꿀 값은 전부 여기 있습니다. 근거는 각 주석에. */
export const ASSUMPTIONS = {
  /** 목표 — 사용자가 정한 값 (2026-09-11) */
  registeredUsers: 10_000,
  dau: 3_000,

  /**
   * 세션/일/DAU = 1.5
   * 오락실 파인더는 "나가기 전에 한 번 확인" + "저녁에 커뮤니티 눈팅" 두 갈래라
   * 하루 한 번짜리 도구보다는 잦고, 메신저처럼 상주하지는 않습니다.
   */
  sessionsPerDau: 1.5,

  /**
   * 세션 길이 4분 — 동시 사용자 수를 내는 데만 씁니다.
   * 지도에서 한두 곳 열어 보고 닫는 길이.
   */
  sessionMinutes: 4,

  /**
   * 피크아워 점유율 18%
   * 오락실 트래픽은 평일 21~23시에 몰립니다. 일반 커뮤니티의 10~15% 보다
   * 뾰족하게 잡았습니다. (실사용 로그가 쌓이면 이 값부터 교정하세요.)
   */
  peakHourShare: 0.18,

  /**
   * 피크 안의 순간 배수 3배
   * 대회·신작 입고·점검 공지 직후처럼 1분짜리 쏠림.
   */
  burstFactor: 3,

  /**
   * 세션당 API 요청 13.3 → 안전하게 15 로 올려 씁니다.
   * 아래 JOURNEY 를 실측(브라우저 network 패널, 2026-09-11)으로 센 값입니다.
   */
  requestsPerSession: 15,

  /** 성장 헤드룸 — 여기까지는 구성을 안 바꾸고 버텨야 한다 */
  growthMultiple: 10,

  /**
   * 대회·신작 입고 직후의 쏠림 — **한 오락실에** 제보가 몰리는 패턴.
   * 30명이 2분 안에 같은 오락실·같은 기종을 제보한다고 봅니다.
   * 절대량(0.25/s)은 작지만, 전부 **같은 키 위의 트랜잭션**이라
   * 처리량이 아니라 직렬화가 문제인 구간입니다.
   */
  hotspotReporters: 30,
  hotspotMinutes: 2,
};

/**
 * 하루에 일어나는 쓰기 — 1~4부가 한 번도 안 잰 쪽입니다.
 *
 * 읽기와 달리 브라우저로 셀 수가 없어서(누가 언제 쓰는지는 사용자 행동이라)
 * DAU 대비 비율로 잡았습니다. 실사용 로그가 쌓이면 여기부터 교정하세요.
 */
export const WRITE_MIX = [
  { what: '제보 (대기·컨디션·있어요·없어졌어요)', perDay: 210, note: 'DAU 의 5% × 1.4건 — 가장 무거운 쓰기' },
  { what: '댓글', perDay: 165, note: '글당 평균 3개' },
  { what: '난이도 투표 · 클리어 기록', perDay: 400, note: '서열표 이용자' },
  { what: '글 추천 토글', perDay: 250, note: '' },
  { what: '즐겨찾기 토글', perDay: 150, note: '' },
  { what: '글쓰기', perDay: 55, note: '' },
  { what: '리뷰', perDay: 15, note: '1인 1오락실이라 드묾' },
];

/**
 * 세션 한 번이 실제로 때리는 요청 — 프로덕션 빌드에 브라우저를 붙여 셌습니다.
 * (2026-09-11, `next start` + 네트워크 캡처)
 */
export const JOURNEY = [
  { step: '홈 진입', reqs: 3, detail: 'auth/session · machines · arcades(306KB)' },
  { step: '오락실 상세 ×2', reqs: 4, detail: '상세 1회당 reports + reviews' },
  { step: '커뮤니티 목록', reqs: 3, detail: 'auth/session · boards · posts' },
  { step: '글 상세 ×1.5', reqs: 1.5, detail: 'posts/:id (3부에서 1왕복으로 접음)' },
  { step: '서열표', reqs: 2, detail: 'auth/session · tier' },
  { step: '/live 폴링', reqs: 0.8, detail: '세션의 20% 가 2분 체류 · 30초 주기' },
];

export function model(a = ASSUMPTIONS) {
  const sessionsPerDay = a.dau * a.sessionsPerDau;
  const requestsPerDay = sessionsPerDay * a.requestsPerSession;

  const peakHourSessions = sessionsPerDay * a.peakHourShare;
  const peakSessionsPerSec = peakHourSessions / 3600;
  const peakRps = peakSessionsPerSec * a.requestsPerSession;

  const burstRps = peakRps * a.burstFactor;
  const burstSessionsPerSec = peakSessionsPerSec * a.burstFactor;

  // 동시 사용자 = 피크아워 세션 × (세션 길이 / 60분)  — Little's law
  const concurrentUsers = peakHourSessions * (a.sessionMinutes / 60);

  const growthRps = peakRps * a.growthMultiple;
  const growthSessionsPerSec = peakSessionsPerSec * a.growthMultiple;

  // ── 쓰기 ──────────────────────────────────────────────
  const writesPerDay = WRITE_MIX.reduce((sum, w) => sum + w.perDay, 0);
  const peakWritesPerSec = (writesPerDay * a.peakHourShare) / 3600;
  // 읽기 대비 비율 — "이 서비스는 읽기가 몇 배인가"
  const readWriteRatio = requestsPerDay / writesPerDay;
  // 쏠림: 한 오락실에 몰리는 순간 도착률
  const hotspotWritesPerSec = a.hotspotReporters / (a.hotspotMinutes * 60);

  return {
    writesPerDay,
    peakWritesPerSec,
    readWriteRatio,
    hotspotWritesPerSec,
    sessionsPerDay,
    requestsPerDay,
    peakHourSessions,
    peakSessionsPerSec,
    peakRps,
    burstSessionsPerSec,
    burstRps,
    concurrentUsers,
    growthSessionsPerSec,
    growthRps,
  };
}

/** 세션당 요청 수를 JOURNEY 에서 다시 세어 ASSUMPTIONS 와 어긋나지 않는지 본다 */
export function journeyTotal() {
  return JOURNEY.reduce((sum, j) => sum + j.reqs, 0);
}

function main() {
  const m = model();
  const measured = journeyTotal();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ assumptions: ASSUMPTIONS, journey: JOURNEY, model: m }, null, 2));
    return;
  }

  const n = (v, d = 1) => Number(v.toFixed(d)).toLocaleString('ko-KR');

  console.log('\n=== 입력 ===');
  console.log(`가입자            ${ASSUMPTIONS.registeredUsers.toLocaleString('ko-KR')}명`);
  console.log(`DAU               ${ASSUMPTIONS.dau.toLocaleString('ko-KR')}명`);
  console.log(`세션/DAU/일       ${ASSUMPTIONS.sessionsPerDau}`);
  console.log(`피크아워 점유율    ${ASSUMPTIONS.peakHourShare * 100}%`);
  console.log(`세션당 요청        ${ASSUMPTIONS.requestsPerSession} (실측 ${measured})`);

  console.log('\n=== 세션당 요청 내역 (실측) ===');
  for (const j of JOURNEY) {
    console.log(`  ${j.step.padEnd(18, ' ')} ${String(j.reqs).padStart(4)}  ${j.detail}`);
  }
  console.log(`  ${'합계'.padEnd(18, ' ')} ${String(measured).padStart(4)}`);

  console.log('\n=== 도출 ===');
  console.log(`세션/일           ${n(m.sessionsPerDay, 0)}`);
  console.log(`API 요청/일       ${n(m.requestsPerDay, 0)}`);
  console.log(`피크아워 세션      ${n(m.peakHourSessions, 0)}`);
  console.log(`동시 사용자        ${n(m.concurrentUsers, 0)}명`);

  console.log('\n=== 설계 목표 ===');
  console.log(`평시 피크          ${n(m.peakRps, 1)} rps   (세션 ${n(m.peakSessionsPerSec, 3)}/s)`);
  console.log(`순간 버스트(×${ASSUMPTIONS.burstFactor})    ${n(m.burstRps, 1)} rps   (세션 ${n(m.burstSessionsPerSec, 3)}/s)`);
  console.log(`성장 헤드룸(×${ASSUMPTIONS.growthMultiple})   ${n(m.growthRps, 1)} rps   (DAU ${(ASSUMPTIONS.dau * ASSUMPTIONS.growthMultiple).toLocaleString('ko-KR')} 상당)`);

  console.log('');
  console.log('=== 쓰기 ===');
  for (const w of WRITE_MIX) {
    console.log(`  ${w.what.padEnd(30, ' ')} ${String(w.perDay).padStart(5)}/일  ${w.note}`);
  }
  console.log(`  ${'합계'.padEnd(30, ' ')} ${String(m.writesPerDay).padStart(5)}/일`);
  console.log('');
  console.log(`피크 쓰기          ${n(m.peakWritesPerSec, 3)} writes/s`);
  console.log(`읽기:쓰기 비율      ${n(m.readWriteRatio, 0)} : 1`);
  console.log(`쏠림(대회 직후)     ${n(m.hotspotWritesPerSec, 2)} writes/s — 전부 같은 오락실·기종`);
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('capacity-model.mjs')) {
  main();
}
