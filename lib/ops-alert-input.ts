import type { OpsAlertAi, OpsAlertCheck, OpsAlertStatus } from './ops-alert-types';
import { lasted, OPS_OPEN_URL } from './ops-alert-types';
import type { GrafanaAlert } from './validation';

/**
 * 운영 알림의 순수 함수 — Grafana 본문 다듬기 · 모델 입력 · 모델 출력 다듬기 · 푸시 문구.
 *
 * DB · 네트워크를 만지지 않아 테스트에서 그대로 부릅니다(tests/ops-alerts.test.ts).
 */

/** 표 한 줄로 넣을 값 */
export interface OpsAlertInput {
  fingerprint: string;
  startsAt: Date;
  status: OpsAlertStatus;
  alertname: string;
  severity: string | null;
  summary: string | null;
  labels: Record<string, string>;
  evalValues: Record<string, number> | null;
  generatorUrl: string | null;
  endsAt: Date | null;
}

/** 라벨은 이만큼만 — 규칙이 라벨을 수십 개 붙여도 표 · 모델 입력이 커지지 않게 */
export const MAX_LABELS = 30;
const MAX_LABEL_VALUE = 300;
const MAX_VALUES = 10;
const MAX_SUMMARY = 500;

/** Grafana 는 "아직 안 끝남" 을 0001-01-01 로 보냅니다 — 그 이전 값은 끝나지 않은 것으로 봅니다 */
const NOT_ENDED_BEFORE = Date.UTC(2000, 0, 1);

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Grafana 알림 하나를 표 한 줄로. 시작 시각을 읽을 수 없으면 null — 그 알림은 버립니다
 * (사건을 가리는 키라 지어낼 수 없습니다).
 */
export function normalizeGrafanaAlert(a: GrafanaAlert): OpsAlertInput | null {
  const startsAt = new Date(a.startsAt);
  if (Number.isNaN(startsAt.getTime())) return null;
  const ends = a.endsAt ? new Date(a.endsAt) : null;
  const endsAt = ends && !Number.isNaN(ends.getTime()) && ends.getTime() > NOT_ENDED_BEFORE ? ends : null;

  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.labels).slice(0, MAX_LABELS)) labels[k] = clip(v, MAX_LABEL_VALUE);

  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.values ?? {})) {
    if (Object.keys(values).length >= MAX_VALUES) break;
    if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
  }

  const summary = a.annotations.summary ?? a.annotations.description ?? null;
  const url = a.generatorURL?.trim() ?? '';
  return {
    fingerprint: a.fingerprint,
    startsAt,
    status: a.status,
    // 규칙 이름이 없는 알림(직접 만든 웹훅 시험 등)도 받습니다 — 목록에서 알아볼 이름은 있어야 합니다
    alertname: clip(a.labels.alertname ?? '이름 없는 알림', 200),
    severity: a.labels.severity ? clip(a.labels.severity, 40) : null,
    summary: summary ? clip(summary, MAX_SUMMARY) : null,
    labels,
    evalValues: Object.keys(values).length ? values : null,
    // 화면에 링크로 걸므로 http(s) 만
    generatorUrl: /^https?:\/\//.test(url) ? url.slice(0, 1000) : null,
    endsAt,
  };
}

/**
 * 브라우저 푸시 서버의 주소인가. 관리자만 구독을 등록하지만, 그래도 아무 https 주소나 받으면
 * 우리 서버가 그 주소로 요청을 보내는 통로가 됩니다 — 알려진 푸시 서버만 받습니다.
 *   Chrome · 삼성 인터넷 · Edge(크로미엄) → fcm.googleapis.com
 *   Firefox → updates.push.services.mozilla.com
 *   Safari(macOS · iOS 홈 화면 앱) → web.push.apple.com
 *   옛 Edge · Windows → *.notify.windows.com
 */
export function isKnownPushEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  return (
    host === 'fcm.googleapis.com' ||
    host === 'android.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com')
  );
}

// ─── 모델 입력 ──────────────────────────────────────────────
/**
 * 알림 하나를 모델에 보낼 때의 최대 글자 수 (GUIDELINES.md §4-7).
 * 위의 상한(라벨 30개 × 300자 · 설명 500자 · 값 10개)을 다 채워도 이 안에 듭니다 — 넘으면 자릅니다.
 */
export const PROMPT_MAX_CHARS = 12_000;

export interface PromptContext {
  /** 같은 규칙이 최근 7일 동안 울린 횟수 (이번 것 포함) */
  recentCount: number;
}

export function buildAlertPrompt(a: OpsAlertInput, ctx: PromptContext, now: Date = new Date()): string {
  const lines = [
    `알림 이름: ${a.alertname}`,
    `상태: ${a.status === 'firing' ? '울리는 중' : '풀림'}`,
    `심각도: ${a.severity ?? '없음'}`,
    `울리기 시작: ${a.startsAt.toISOString()} (지금은 ${now.toISOString()})`,
    a.endsAt ? `풀린 때: ${a.endsAt.toISOString()}` : null,
    `규칙 설명: ${a.summary ?? '없음'}`,
    a.evalValues
      ? `평가한 값: ${Object.entries(a.evalValues)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`
      : '평가한 값: 없음',
    `라벨: ${Object.entries(a.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || '없음'}`,
    `같은 규칙이 최근 7일 동안 울린 횟수: ${ctx.recentCount}번`,
  ].filter((l): l is string => l !== null);
  const text = lines.join('\n');
  return text.length > PROMPT_MAX_CHARS ? text.slice(0, PROMPT_MAX_CHARS) : text;
}

// ─── 모델 출력 ──────────────────────────────────────────────
function line(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
}

/**
 * 모델이 준 JSON 을 화면에 내보낼 수 있게 다듬습니다. 제목이 없으면 쓸 수 없는 요약이라 null.
 * 명령은 한 줄로만 — 줄바꿈이 섞이면 복사해 붙였을 때 두 명령이 됩니다.
 */
export function tidyAi(raw: unknown): OpsAlertAi | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const headline = line(o.headline, 80);
  if (!headline) return null;
  const causes = (Array.isArray(o.causes) ? o.causes : [])
    .map((c) => line(c, 160))
    .filter((c): c is string => c !== null)
    .slice(0, 3);
  const checks: OpsAlertCheck[] = (Array.isArray(o.checks) ? o.checks : [])
    .map((c): OpsAlertCheck | null => {
      const r = (c ?? {}) as Record<string, unknown>;
      const what = line(r.what, 160);
      if (!what) return null;
      const cmd = typeof r.command === 'string' ? r.command.split('\n')[0].trim() : '';
      return { what, command: cmd ? cmd.slice(0, 300) : null };
    })
    .filter((c): c is OpsAlertCheck => c !== null)
    .slice(0, 4);
  return { headline, impact: line(o.impact, 300) ?? '영향은 아직 알 수 없어요', causes, checks };
}

// ─── 푸시 문구 ──────────────────────────────────────────────
export interface PushMessage {
  title: string;
  body: string;
  /** 같은 알림의 푸시를 덮어씁니다 — 울림 뒤 풀림이 오면 알림 센터에 한 줄만 남습니다 */
  tag: string;
  url: string;
}

export interface PushSource {
  id: number;
  status: OpsAlertStatus;
  alertname: string;
  summary: string | null;
  startsAt: string;
  endsAt: string | null;
  ai: OpsAlertAi | null;
}

export function pushMessageFor(a: PushSource): PushMessage {
  const tag = `ops-alert-${a.id}`;
  if (a.status === 'resolved') {
    return {
      title: `풀렸어요 · ${a.alertname}`,
      body: a.endsAt ? `울린 지 ${lasted(a.startsAt, a.endsAt)} 만에 풀렸어요.` : '알림이 풀렸어요.',
      tag,
      url: OPS_OPEN_URL,
    };
  }
  return {
    title: `울려요 · ${a.ai?.headline ?? a.alertname}`,
    body: clip(a.ai?.impact ?? a.summary ?? '자세한 내용은 운영 알림에서 볼 수 있어요.', 180),
    tag,
    url: OPS_OPEN_URL,
  };
}
