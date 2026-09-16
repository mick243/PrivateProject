import { monitorEventLoopDelay } from 'node:perf_hooks';
import { NodeTracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { recordHttp, startReporter } from './telemetry';

/**
 * Next.js 가 내장으로 내보내는 OpenTelemetry 스팬을 받아 라우트별 요청 지표로 바꾼다.
 *
 * 라우트 파일을 하나도 고치지 않고 모든 핸들러가 잡히는 이유 — Next 가 요청마다
 * `BaseServer.handleRequest` 스팬을 만들고 거기에 라우트 패턴(`next.route`)·메서드·상태코드·
 * 소요시간을 실어 준다. 우리는 exporter 를 붙이는 대신 SpanProcessor.onEnd 에서 그 값만 뽑는다.
 * 트레이스를 어디로 내보내는 것이 아니므로 collector 도, OTLP 도 필요 없다.
 *
 * instrumentation.ts 가 nodejs 런타임일 때만 이 모듈을 불러온다 (NodeTracerProvider 는 edge 비호환).
 */

/** 감시 자체가 만드는 요청과 정적 자원은 지표에서 뺀다 */
const IGNORE = [/^\/_next\//, /^\/api\/health$/, /^\/favicon/, /^\/__nextjs/, /^\/\.well-known\//];

class PulseSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const a = span.attributes;
    if (a['next.span_type'] !== 'BaseServer.handleRequest') return;

    const method = String(a['http.method'] ?? a['http.request.method'] ?? 'GET');
    // 매칭된 라우트 패턴이 최선. 없으면(404 등) 실제 경로 — telemetry 쪽에서 숫자 세그먼트를 접는다
    const route = String(a['next.route'] ?? a['http.route'] ?? a['http.target'] ?? span.name.replace(/^\S+\s+/, ''));
    if (IGNORE.some((re) => re.test(route))) return;

    const status = Number(a['http.status_code'] ?? a['http.response.status_code'] ?? 0);
    const [sec, nanos] = span.duration;
    recordHttp(`${method} ${route}`, status, sec * 1000 + nanos / 1e6);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 이벤트 루프 지연 감시를 켠다.
 *
 * **왜 독립 지표여야 하나** — 노드는 싱글 스레드라 CPU 가 포화되면 `await` 가 늦게
 * 깨어난다. 그 지연은 그때 진행 중이던 모든 await 에 얹히므로, DB 시간을 재는 코드가
 * 그것까지 쿼리 시간으로 기록한다. 실제로 `SELECT 1` 하나짜리 라우트가 p95 3초로
 * 찍힌 적이 있다 (2026-09-08). 루프 지연을 따로 두면 그 상황이 "쿼리가 느리다" 가
 * 아니라 "프로세스가 밀린다" 로 읽힌다.
 *
 * 히스토그램은 C++ 쪽에서 채우므로 JS 이벤트 루프에 얹히는 비용이 없다.
 * `resolution` 은 표본 간격이고, 한가한 루프에서도 이 값 근처가 바닥값으로 나온다 —
 * 절대값보다 **부하 전후의 변화**를 본다.
 *
 * globalThis 에 두는 이유는 lib/telemetry.ts 의 상태와 같다: Next 가 instrumentation
 * 번들과 앱 번들을 따로 만들어서, 모듈 스코프에 두면 snapshot() 이 읽지 못한다.
 */
const LOOP_RESOLUTION_MS = 10;

function startLoopLagMonitor(): void {
  const g = globalThis as unknown as { __pulseLoopLag?: ReturnType<typeof monitorEventLoopDelay> };
  if (g.__pulseLoopLag) return; // dev HMR 로 두 번 불려도 하나만
  const h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  h.enable();
  g.__pulseLoopLag = h;
}

export function startTelemetry(): boolean {
  // 키가 없으면 OTel 도 켜지 않는다 — 스팬을 만드는 비용조차 들이지 않는다
  if (!startReporter()) return false;
  startLoopLagMonitor();
  const provider = new NodeTracerProvider({ spanProcessors: [new PulseSpanProcessor()] });
  provider.register();
  console.log(
    `[telemetry] Pulse 계측 시작 → ${process.env.PULSE_API_URL} (agent ${process.env.PULSE_AGENT_ID ?? 'arcade-finder'})` +
      ` · 이벤트 루프 감시 ${LOOP_RESOLUTION_MS}ms`,
  );
  return true;
}
