import { NextResponse } from 'next/server';
import { fail, handle, parseBody, unavailable } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth';
import { countAdminSubscriptions, deletePushSubscription, pushKeys, savePushSubscription } from '@/lib/ops-push';
import { pushSubscriptionSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 운영 알림의 기기 푸시 구독 (관리자 전용) — lib/ops-push.ts
 *
 *   GET    → { publicKey, devices }  브라우저가 구독할 때 쓰는 VAPID 공개 키 · 지금 켜진 기기 수
 *   PUT    → 이 기기를 켭니다. 본문은 PushSubscription.toJSON()
 *   DELETE → 이 기기를 끕니다. ?endpoint=<구독 주소> (본문 없음 — GUIDELINES.md §4-1)
 *
 * 켜고 끄는 쪽 모두 원하는 상태를 받으므로 두 번 불러도 같습니다.
 */
export const GET = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const keys = pushKeys();
  if (!keys) return unavailable('서버에 푸시 키가 없어요. install-monitoring.sh 를 다시 돌려 주세요');
  return NextResponse.json({ publicKey: keys.publicKey, devices: await countAdminSubscriptions() });
});

export const PUT = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  if (!pushKeys()) return unavailable('서버에 푸시 키가 없어요. install-monitoring.sh 를 다시 돌려 주세요');
  const body = await parseBody(request, pushSubscriptionSchema, 'first');
  if (!body.ok) return body.response;
  await savePushSubscription(guard.user.playerId, body.value, request.headers.get('user-agent'));
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (request: Request) => {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  const endpoint = new URL(request.url).searchParams.get('endpoint')?.trim();
  if (!endpoint) return fail(400, '끌 기기의 구독 주소(endpoint)가 필요해요');
  await deletePushSubscription(guard.user.playerId, endpoint);
  return NextResponse.json({ ok: true });
});
