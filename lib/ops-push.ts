import { sendNotification, WebPushError } from 'web-push';
import type { PushMessage } from './ops-alert-input';
import { getPrismaClient } from './prisma';
import type { PushSubscriptionInput } from './validation';

/**
 * 운영 알림을 관리자 기기로 보내는 웹 푸시 (ops_push_subscriptions, migrate-081).
 *
 * ─── 키 ──────────────────────────────────────────────────
 * 웹 푸시는 서버가 VAPID 키 쌍으로 서명합니다. 공개 키는 브라우저가 구독할 때 받아 가고
 * (GET /api/ops/push), 비밀 키는 서버에만 있습니다. 운영 서버에서는 install-monitoring.sh 가
 * METRICS_TOKEN 과 같은 자리에서 만들어 .env.local 에 넣습니다 — PC 의 값은 서버로 가지 않습니다
 * (make-server-env.sh 가 OPS_* 를 건너뜀). 키가 없으면 푸시만 꺼지고 알림 목록은 그대로입니다.
 *
 * ─── 누구에게 ─────────────────────────────────────────────
 * 구독은 관리자만 등록할 수 있고(라우트가 requireAdmin), 보낼 때도 **지금** 관리자인 사람의
 * 구독만 고릅니다 — 권한을 뗀 계정의 기기로 운영 알림이 계속 가지 않게 (GUIDELINES.md §5).
 *
 * ─── 실패 ─────────────────────────────────────────────────
 * 브라우저가 구독을 버렸다고 답하면(404 · 410 — 알림을 끄거나 앱을 지움) 그 줄을 바로 지웁니다.
 * 그 밖의 실패는 세어 두었다가 연달아 FAILURE_LIMIT 번이면 지웁니다. 한 기기의 실패가
 * 다른 기기로 가는 것을 막지 않습니다.
 */

const FAILURE_LIMIT = 5;
/** 푸시 서버가 기기를 못 만나면 이만큼 들고 있다가 버립니다 — 하루 지난 장애 알림은 뜻이 없습니다 */
const TTL_SECONDS = 6 * 60 * 60;

export interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * VAPID 키 셋. 없으면 null (푸시 꺼짐).
 * subject 는 푸시 서버가 문제를 알릴 연락처 — https 주소나 mailto 여야 하고, Apple 은 localhost 를
 * 거절합니다. 따로 정하지 않으면 사이트 주소(APP_URL)를 씁니다.
 */
export function pushKeys(): PushKeys | null {
  const publicKey = process.env.OPS_PUSH_PUBLIC_KEY?.trim();
  const privateKey = process.env.OPS_PUSH_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const appUrl = process.env.APP_URL?.trim() ?? '';
  const subject =
    process.env.OPS_PUSH_SUBJECT?.trim() ||
    (appUrl.startsWith('https://') ? appUrl : 'mailto:ops@arcade-finder.invalid');
  return { publicKey, privateKey, subject };
}

/** 이 기기를 구독에 넣습니다. 같은 주소가 이미 있으면(다시 켬 · 다른 관리자 계정) 지금 계정으로 바꿉니다 */
export async function savePushSubscription(
  playerId: number,
  sub: PushSubscriptionInput,
  userAgent: string | null,
): Promise<void> {
  const prisma = await getPrismaClient();
  const data = {
    player_id: playerId,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    user_agent: userAgent ? userAgent.slice(0, 300) : null,
    failures: 0,
  };
  await prisma.ops_push_subscriptions.upsert({
    where: { endpoint: sub.endpoint },
    create: { endpoint: sub.endpoint, ...data },
    update: data,
  });
}

/** 이 기기의 구독을 지웁니다. 남의 계정 구독은 지우지 않습니다. 없어도 성공입니다 */
export async function deletePushSubscription(playerId: number, endpoint: string): Promise<void> {
  const prisma = await getPrismaClient();
  await prisma.ops_push_subscriptions.deleteMany({ where: { endpoint, player_id: playerId } });
}

/** 지금 관리자인 사람의 구독 수 — 화면이 "켜진 기기 N대" 로 보여 줍니다 */
export async function countAdminSubscriptions(): Promise<number> {
  const prisma = await getPrismaClient();
  return prisma.ops_push_subscriptions.count({ where: { players: { is_admin: true } } });
}

export interface PushOutcome {
  sent: number;
  failed: number;
  removed: number;
}

/** 지금 관리자인 사람의 모든 기기로 보냅니다. 키가 없으면 아무것도 안 합니다 */
export async function sendOpsPush(message: PushMessage): Promise<PushOutcome> {
  const outcome: PushOutcome = { sent: 0, failed: 0, removed: 0 };
  const keys = pushKeys();
  if (!keys) return outcome;

  const prisma = await getPrismaClient();
  const subs = await prisma.ops_push_subscriptions.findMany({
    where: { players: { is_admin: true } },
    select: { id: true, endpoint: true, p256dh: true, auth: true, failures: true },
    orderBy: { id: 'asc' },
    take: 50,
  });
  const payload = JSON.stringify(message);

  await Promise.all(
    subs.map(async (s) => {
      try {
        await sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: keys,
          TTL: TTL_SECONDS,
          urgency: 'high',
          // 같은 알림의 푸시가 아직 기기에 닿지 않았으면 새 것으로 바꿔 놓습니다 (32자 · URL-safe)
          topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
          timeout: 10_000,
        });
        outcome.sent++;
        await prisma.ops_push_subscriptions.update({ where: { id: s.id }, data: { last_ok_at: new Date(), failures: 0 } });
      } catch (err) {
        outcome.failed++;
        const status = err instanceof WebPushError ? err.statusCode : null;
        if (status === 404 || status === 410 || s.failures + 1 >= FAILURE_LIMIT) {
          await prisma.ops_push_subscriptions.deleteMany({ where: { id: s.id } });
          outcome.removed++;
        } else {
          await prisma.ops_push_subscriptions.update({ where: { id: s.id }, data: { failures: { increment: 1 } } });
        }
        // 주소에는 기기를 가리키는 값이 들어 있어 호스트만 남깁니다
        console.warn(
          `[ops-push] ${new URL(s.endpoint).host} 로 보내지 못함 — ${status ?? (err instanceof Error ? err.message : err)}`,
        );
      }
    }),
  );
  return outcome;
}
