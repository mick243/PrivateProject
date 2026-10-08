import { after, NextResponse } from 'next/server';
import { handle, tooMany } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { processAlertEvents } from '@/lib/ops-alert-events';
import { recordAlerts } from '@/lib/ops-alerts';
import { consume, HOUR_MS, retryAfterLabel } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 한 관리자가 한 시간에 보낼 수 있는 시험 알림 — 요약이 모델을 한 번씩 부릅니다 */
const TEST_PER_HOUR = 10;

/**
 * POST /api/ops/alerts/test — 시험 알림 하나를 만들어 요약 · 푸시까지 그대로 태웁니다 (관리자 전용).
 *
 * Grafana 를 거치지 않고 이 기기에 알림이 오는지 볼 때 씁니다. Grafana 연락 지점의 "Test" 단추는
 * 웹훅 경로까지 시험하고, 이건 앱 안쪽(저장 → 요약 → 푸시)만 시험합니다. 매번 새 사건이라
 * 멱등하지 않습니다 — 그래서 시간당 횟수를 막습니다.
 */
export const POST = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const quota = await consume(`ops-alert-test:player:${guard.user.playerId}`, TEST_PER_HOUR, HOUR_MS);
  if (!quota.allowed) {
    return tooMany(`시험 알림은 한 시간에 ${TEST_PER_HOUR}번까지예요. ${retryAfterLabel(quota.retryAfterMs)} 뒤에 다시 보내 주세요`, quota.retryAfterMs);
  }

  const now = new Date();
  const result = await recordAlerts([
    {
      fingerprint: `admin-test-${now.getTime()}`,
      startsAt: now,
      status: 'firing',
      alertname: 'TestAlert',
      severity: 'info',
      summary: '관리자가 보낸 시험 알림이에요. 요약과 기기 알림이 오는지 보려고 보냈어요.',
      labels: { alertname: 'TestAlert', severity: 'info', source: 'admin-test' },
      evalValues: null,
      generatorUrl: null,
      endsAt: null,
    },
  ]);
  after(() => processAlertEvents(result));
  return NextResponse.json({ id: result.fired[0] ?? null }, { status: 202 });
});
