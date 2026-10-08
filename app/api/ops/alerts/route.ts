import { after, NextResponse } from 'next/server';
import { fail, handle, notFound, parseBody, parseId } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { bearerMatches } from '@/lib/bearer-token';
import { processAlertEvents } from '@/lib/ops-alert-events';
import { normalizeGrafanaAlert, type OpsAlertInput } from '@/lib/ops-alert-input';
import type { OpsAlertsResponse } from '@/lib/ops-alert-types';
import { dismissAlert, dismissResolvedAlerts, listAlerts, recordAlerts } from '@/lib/ops-alerts';
import { pushKeys } from '@/lib/ops-push';
import { grafanaWebhookSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/ops/alerts — Grafana Cloud 알림 웹훅 (연락 지점의 Webhook 통합).
 *
 * 응답 코드
 *   404  OPS_ALERT_TOKEN 이 없음 — 꺼진 환경에서는 이 경로가 있다는 것도 드러내지 않는다
 *   401  `Authorization: Bearer <OPS_ALERT_TOKEN>` 이 아님
 *   400  Grafana 알림 모양이 아님
 *   200  받음. 요약 · 푸시는 응답한 뒤에 한다 (after — Grafana 는 응답이 늦으면 다시 보낸다)
 *
 * 밖(Grafana Cloud)에서 부르는 경로라 Caddy 가 막지 않는다 — 대신 토큰이 지킨다. 토큰은 서버에서
 * install-monitoring.sh 가 만들고, 관리자가 Grafana 연락 지점에 넣는다 (deploy/ncp/README.md §9-4).
 */
export const POST = handle(async (request: Request) => {
  const token = process.env.OPS_ALERT_TOKEN?.trim() ?? '';
  if (!token) return notFound('찾을 수 없습니다');
  if (!bearerMatches(request.headers.get('authorization'), token)) {
    const res = fail(401, '알림 토큰이 맞지 않아요');
    res.headers.set('www-authenticate', 'Bearer');
    return res;
  }

  const body = await parseBody(request, grafanaWebhookSchema);
  if (!body.ok) return body.response;
  const inputs = body.value.alerts
    .map(normalizeGrafanaAlert)
    .filter((a): a is OpsAlertInput => a !== null);

  const result = await recordAlerts(inputs);
  if (result.fired.length || result.resolved.length) after(() => processAlertEvents(result));

  return NextResponse.json({
    received: inputs.length,
    fired: result.fired.length,
    resolved: result.resolved.length,
    repeated: result.repeated,
    dismissed: result.dismissed,
  });
});

/**
 * GET /api/ops/alerts — 관리자 화면의 종 아이콘이 1분마다 읽습니다 (components/OpsAlertBell.tsx).
 * 최근 30개(바뀐 때 순) · 안 읽은 수 · 이 서버에서 기기 알림을 켤 수 있는지.
 */
export const GET = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const { alerts, unread } = await listAlerts();
  const res: OpsAlertsResponse = { alerts, unread, pushReady: pushKeys() !== null };
  return NextResponse.json(res, { headers: { 'cache-control': 'no-store' } });
});

/**
 * DELETE /api/ops/alerts — 목록에서 지우기 (관리자 전용). 본문 없이 쿼리로 (GUIDELINES.md §4-1)
 *
 *   ?id=12              알림 하나 (울리는 중이어도)
 *   ?status=resolved    풀린 알림 전부 — 울리는 중인 것은 남깁니다
 *
 * 줄은 남기고 지운 시각만 찍습니다 — 같은 사건의 반복 · 풀림이 와도 다시 뜨지 않게 (migrate-082).
 * 이미 지운 것을 다시 지워도 같은 결과라 { dismissed: 0 } 로 답합니다.
 */
export const DELETE = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const q = new URL(request.url).searchParams;
  const rawId = q.get('id');
  const status = q.get('status');

  if (rawId !== null && status === null) {
    const id = parseId(rawId);
    if (id === null) return fail(400, '지울 알림의 id 가 올바르지 않아요');
    return NextResponse.json({ dismissed: await dismissAlert(id) });
  }
  if (rawId === null && status === 'resolved') {
    return NextResponse.json({ dismissed: await dismissResolvedAlerts() });
  }
  return fail(400, '지울 알림을 ?id= 나 ?status=resolved 중 하나로 알려 주세요');
});
