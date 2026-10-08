import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * `Authorization: Bearer <토큰>` 이 기대한 토큰과 같은가 — 기계가 부르는 경로가 같이 씁니다.
 *   GET  /api/metrics     ← 서버의 수집기 (METRICS_TOKEN)
 *   POST /api/ops/alerts  ← Grafana Cloud 알림 웹훅 (OPS_ALERT_TOKEN)
 *
 * 해시끼리 견줍니다 — 길이가 같아져 timingSafeEqual 이 던지지 않고, 길이도 새지 않습니다.
 * 기대한 토큰이 비어 있으면 늘 false 입니다(빈 헤더로 통과하지 않게). 부르는 쪽은 그 전에
 * 기능이 꺼졌다고 보고 404 를 돌려줍니다.
 */
export function bearerMatches(header: string | null, token: string): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token));
}
