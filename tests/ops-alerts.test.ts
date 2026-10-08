import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildAlertPrompt,
  isKnownPushEndpoint,
  MAX_LABELS,
  normalizeGrafanaAlert,
  PROMPT_MAX_CHARS,
  pushMessageFor,
  tidyAi,
  type OpsAlertInput,
} from '@/lib/ops-alert-input';
import { ago, lasted, OPS_OPEN_URL } from '@/lib/ops-alert-types';
import { grafanaWebhookSchema, pushSubscriptionSchema, type GrafanaAlert } from '@/lib/validation';

/**
 * 운영 알림의 순수 부분 — Grafana 본문 다듬기 · 모델 입력의 상한 · 모델 출력 다듬기 · 푸시 문구.
 * DB · 네트워크를 쓰는 쪽은 tests/ops-alerts-routes.test.ts · tests/ops-push.test.ts.
 */

/** Grafana 가 실제로 보내는 모양 (2026-10 Grafana Cloud 웹훅 문서의 예와 같은 칸) */
function grafana(over: Partial<GrafanaAlert> = {}): GrafanaAlert {
  return {
    status: 'firing',
    labels: { alertname: 'DiskLow', severity: 'warning', instance: '127.0.0.1:9100', grafana_folder: 'arcade-finder' },
    annotations: { summary: '디스크 여유가 15% 아래입니다' },
    startsAt: '2026-10-06T08:20:50Z',
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: 'https://example.grafana.net/alerting/grafana/abc/view',
    fingerprint: '6a1b2c3d4e5f6a7b',
    values: { A: 0.142, C: 1 },
    ...over,
  };
}

describe('normalizeGrafanaAlert', () => {
  it('울리는 중이면 Grafana 의 0001-01-01 끝 시각을 "안 끝남"(null) 으로 읽는다', () => {
    const a = normalizeGrafanaAlert(grafana())!;
    expect(a.endsAt).toBeNull();
    expect(a.startsAt.toISOString()).toBe('2026-10-06T08:20:50.000Z');
    expect(a.alertname).toBe('DiskLow');
    expect(a.severity).toBe('warning');
    expect(a.summary).toBe('디스크 여유가 15% 아래입니다');
    expect(a.evalValues).toEqual({ A: 0.142, C: 1 });
  });

  it('시작 시각을 읽을 수 없으면 버린다 — 사건을 가리는 키라 지어낼 수 없다', () => {
    expect(normalizeGrafanaAlert(grafana({ startsAt: '어제' }))).toBeNull();
  });

  it('라벨은 상한까지만, 값이 아닌 평가 값(null)은 빼고, 링크는 http(s) 만', () => {
    const labels = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(1000)]));
    const a = normalizeGrafanaAlert(
      grafana({ labels, values: { A: null, B: 2 }, generatorURL: 'javascript:alert(1)' }),
    )!;
    expect(Object.keys(a.labels)).toHaveLength(MAX_LABELS);
    expect(a.labels.k0.length).toBeLessThanOrEqual(300);
    expect(a.evalValues).toEqual({ B: 2 });
    expect(a.generatorUrl).toBeNull();
    // 규칙 이름이 없는 알림도 받는다 — 목록에서 알아볼 이름은 있어야 한다
    expect(a.alertname).toBe('이름 없는 알림');
  });

  it('설명은 summary 가 없으면 description 을 쓴다', () => {
    const a = normalizeGrafanaAlert(grafana({ annotations: { description: '설명' } }))!;
    expect(a.summary).toBe('설명');
  });
});

describe('grafanaWebhookSchema', () => {
  it('Grafana 의 다른 칸(receiver · groupKey …)은 버리고 alerts 만 받는다', () => {
    const r = grafanaWebhookSchema.safeParse({ receiver: 'empty', status: 'firing', groupKey: 'x', alerts: [grafana()] });
    expect(r.success).toBe(true);
    expect(Object.keys(r.data!)).toEqual(['alerts']);
  });

  it('알림이 없거나 모양이 다르면 받지 않는다', () => {
    expect(grafanaWebhookSchema.safeParse({ alerts: [] }).success).toBe(false);
    expect(grafanaWebhookSchema.safeParse({ alerts: [{ ...grafana(), status: 'pending' }] }).success).toBe(false);
    expect(grafanaWebhookSchema.safeParse({ alerts: [{ ...grafana(), fingerprint: '' }] }).success).toBe(false);
  });
});

describe('buildAlertPrompt — AI 입력 상한 (GUIDELINES.md §4-7)', () => {
  it('상한을 다 채운 최악의 알림도 PROMPT_MAX_CHARS 안이다', () => {
    const labels = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${'k'.repeat(190)}${i}`, 'v'.repeat(2000)]));
    const values = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`R${i}`, i / 3]));
    const worst = normalizeGrafanaAlert(
      grafana({ labels, values, annotations: { summary: 's'.repeat(4000) } }),
    )!;
    const prompt = buildAlertPrompt(worst, { recentCount: 99 });
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });

  it('평가한 값과 최근 횟수를 근거로 싣는다', () => {
    const p = buildAlertPrompt(normalizeGrafanaAlert(grafana())!, { recentCount: 3 }, new Date('2026-10-06T08:31:00Z'));
    expect(p).toContain('평가한 값: A=0.142, C=1');
    expect(p).toContain('최근 7일 동안 울린 횟수: 3번');
    expect(p).toContain('상태: 울리는 중');
  });
});

describe('tidyAi', () => {
  it('제목이 없으면 쓸 수 없는 요약이다', () => {
    expect(tidyAi({ impact: '영향' })).toBeNull();
    expect(tidyAi('문자열')).toBeNull();
    expect(tidyAi(null)).toBeNull();
  });

  it('개수와 길이를 자르고, 명령은 한 줄만 남긴다', () => {
    const ai = tidyAi({
      headline: '  디스크 여유가   15% 아래로 내려갔어요 ',
      impact: '',
      causes: ['a', 'b', 'c', 'd', 3],
      checks: [
        { what: '디스크 확인', command: 'df -h /\nrm -rf /' },
        { what: '묶음 확인', command: null },
        { what: '', command: 'free -m' },
        { what: '4' },
        { what: '5' },
        { what: '6' },
      ],
    })!;
    expect(ai.headline).toBe('디스크 여유가 15% 아래로 내려갔어요');
    expect(ai.impact).toBe('영향은 아직 알 수 없어요');
    expect(ai.causes).toEqual(['a', 'b', 'c']);
    expect(ai.checks).toHaveLength(4);
    expect(ai.checks[0]).toEqual({ what: '디스크 확인', command: 'df -h /' });
    expect(ai.checks[1].command).toBeNull();
  });
});

describe('pushMessageFor', () => {
  const base = {
    id: 12,
    alertname: 'DiskLow',
    summary: '디스크 여유가 15% 아래입니다',
    startsAt: '2026-10-06T08:20:50Z',
    endsAt: null,
    ai: null,
  };

  it('울림은 요약 제목을, 없으면 규칙 이름을 쓴다. 누르면 운영 알림 패널로', () => {
    const m = pushMessageFor({
      ...base,
      status: 'firing',
      ai: { headline: '디스크 여유가 부족해요', impact: '새 배포가 실패할 수 있어요', causes: [], checks: [] },
    });
    expect(m).toEqual({ title: '울려요 · 디스크 여유가 부족해요', body: '새 배포가 실패할 수 있어요', tag: 'ops-alert-12', url: OPS_OPEN_URL });
    expect(pushMessageFor({ ...base, status: 'firing' }).title).toBe('울려요 · DiskLow');
    expect(pushMessageFor({ ...base, status: 'firing' }).body).toBe('디스크 여유가 15% 아래입니다');
  });

  it('풀림은 같은 tag 로 — 알림 센터에서 울림을 덮어쓴다', () => {
    const m = pushMessageFor({ ...base, status: 'resolved', endsAt: '2026-10-06T09:35:50Z' });
    expect(m.tag).toBe('ops-alert-12');
    expect(m.title).toBe('풀렸어요 · DiskLow');
    expect(m.body).toBe('울린 지 1시간 15분 만에 풀렸어요.');
  });
});

describe('푸시 구독 주소', () => {
  it('알려진 브라우저 푸시 서버만 받는다', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QF0abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(isKnownPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x',
      'https://127.0.0.1/x',
      '아무거나',
    ]) {
      expect(isKnownPushEndpoint(bad), bad).toBe(false);
    }
  });

  it('스키마가 그 판정을 쓴다', () => {
    const keys = { p256dh: 'BPa', auth: 'k' };
    expect(pushSubscriptionSchema.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys }).success).toBe(true);
    expect(pushSubscriptionSchema.safeParse({ endpoint: 'https://internal.example/x', keys }).success).toBe(false);
  });
});

describe('시각 표시', () => {
  it('ago · lasted', () => {
    const now = Date.parse('2026-10-06T10:00:00Z');
    expect(ago('2026-10-06T09:59:30Z', now)).toBe('방금');
    expect(ago('2026-10-06T09:57:00Z', now)).toBe('3분 전');
    expect(ago('2026-10-06T07:00:00Z', now)).toBe('3시간 전');
    expect(lasted('2026-10-06T08:00:00Z', '2026-10-06T08:12:00Z')).toBe('12분');
    expect(lasted('2026-10-06T08:00:00Z', '2026-10-06T11:00:00Z')).toBe('3시간');
  });
});

describe('서비스 워커와 화면이 같은 주소를 쓴다', () => {
  const sw = readFileSync('public/sw.js', 'utf8');

  it('알림을 누르면 여는 주소', () => {
    expect(sw).toContain(`const OPS_OPEN_URL = '${OPS_OPEN_URL}';`);
  });

  it('푸시를 받고 누르는 처리가 있고, 그 안에서 캐시를 만지지 않는다', () => {
    const tail = sw.slice(sw.indexOf("addEventListener('push'"));
    expect(tail).toContain("addEventListener('notificationclick'");
    expect(tail).not.toMatch(/caches\.|cache\.put|addAll/);
    // 사이트 밖 주소로는 열지 않는다
    expect(tail).toContain("data.url.startsWith('/')");
  });
});

// 정규화 결과가 표에 그대로 들어가는 모양인지 — 타입이 어긋나면 여기서 먼저 깨집니다
const _typecheck: OpsAlertInput | null = normalizeGrafanaAlert(grafana());
void _typecheck;
