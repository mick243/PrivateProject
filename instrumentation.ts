/**
 * Next.js 서버 프로세스가 뜰 때 한 번 불린다 (docs: app/guides/instrumentation).
 *
 * 1. 운영 필수 환경변수 검사 — 빠졌으면 여기서 죽는다 (lib/env-check.ts). 요청 시점에
 *    500/503 으로 드러나던 것들을 기동 시점으로 앞당긴다.
 * 2. Pulse 계측은 nodejs 런타임에서만 — OTel Node SDK 는 edge 에서 돌지 않으므로 동적 import 로 가른다.
 * 3. 리듬게임 공식 소식 동기화를 **띄우기만** 한다 (lib/news-sync-boot.ts). 기다리지
 *    않는다 — register() 는 서버가 요청을 받기 전에 끝나야 하므로, 남의 사이트 응답을
 *    여기서 기다리면 그 시간이 곧 우리 기동 시간이 된다.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { enforceProductionEnv } = await import('./lib/env-check');
  enforceProductionEnv();
  const { startTelemetry } = await import('./lib/telemetry-node');
  startTelemetry();
  const { startNewsSync } = await import('./lib/news-sync-boot');
  startNewsSync();
}
