import { pushMessageFor, type PushMessage } from './ops-alert-input';
import { OPS_OPEN_URL } from './ops-alert-types';
import { summarizeAlert } from './ops-alert-summary';
import { getAlertView, type RecordResult } from './ops-alerts';
import { sendOpsPush } from './ops-push';

/**
 * 알림을 받은 **뒤** 할 일 — 새로 울린 것은 요약하고, 울림 · 풀림을 관리자 기기로 푸시합니다.
 *
 * 웹훅 라우트가 `after()` 로 부릅니다. 응답은 이미 나갔으므로 여기서 던지면 아무도 받지 못합니다 —
 * 그래서 알림마다 실패를 잡아 로그만 남기고 다음 것으로 넘어갑니다. 요약이 실패해도 푸시는 갑니다
 * (규칙 설명으로).
 *
 * 서버가 흔들리면 규칙 여럿이 한꺼번에 울립니다. 그때 기기로 알림이 여러 개 쏟아지지 않도록
 * 한 번 받은 것에서 PUSH_BURST 개까지만 따로 보내고, 나머지는 "그 밖에 N건" 한 개로 묶습니다.
 */

const PUSH_BURST = 3;

export async function processAlertEvents(r: Pick<RecordResult, 'fired' | 'resolved'>): Promise<void> {
  const messages: PushMessage[] = [];

  for (const id of r.fired) {
    try {
      await summarizeAlert(id);
    } catch (err) {
      console.error(`[ops-alerts] #${id} 요약 중 오류 —`, err instanceof Error ? err.message : err);
    }
    const m = await messageFor(id);
    if (m) messages.push(m);
  }
  for (const id of r.resolved) {
    const m = await messageFor(id);
    if (m) messages.push(m);
  }
  if (!messages.length) return;

  const batch =
    messages.length > PUSH_BURST + 1
      ? [
          ...messages.slice(0, PUSH_BURST),
          {
            title: `그 밖에 ${messages.length - PUSH_BURST}건이 더 있어요`,
            body: '운영 알림에서 한꺼번에 볼 수 있어요.',
            tag: 'ops-alert-more',
            url: OPS_OPEN_URL,
          },
        ]
      : messages;

  for (const m of batch) {
    try {
      const o = await sendOpsPush(m);
      if (o.sent || o.failed) console.info(`[ops-push] "${m.title}" — 보냄 ${o.sent} · 실패 ${o.failed} · 지움 ${o.removed}`);
    } catch (err) {
      console.error('[ops-push] 보내는 중 오류 —', err instanceof Error ? err.message : err);
    }
  }
}

async function messageFor(id: number): Promise<PushMessage | null> {
  try {
    const v = await getAlertView(id);
    return v ? pushMessageFor(v) : null;
  } catch (err) {
    console.error(`[ops-alerts] #${id} 푸시 문구를 만들지 못함 —`, err instanceof Error ? err.message : err);
    return null;
  }
}
