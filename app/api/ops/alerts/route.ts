import { after, NextResponse } from 'next/server';
import { fail, handle, notFound, parseBody } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { bearerMatches } from '@/lib/bearer-token';
import { processAlertEvents } from '@/lib/ops-alert-events';
import { normalizeGrafanaAlert, type OpsAlertInput } from '@/lib/ops-alert-input';
import type { OpsAlertsResponse } from '@/lib/ops-alert-types';
import { listAlerts, recordAlerts } from '@/lib/ops-alerts';
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
