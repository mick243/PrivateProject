import { GoogleGenAI, Type } from '@google/genai';
import { buildAlertPrompt, tidyAi } from './ops-alert-input';
import { countRecentFirings, getAlertInput, saveAlertSummary } from './ops-alerts';
import { consume, DAY_MS, limitFromEnv } from './rate-limit';

/**
 * 운영 알림 하나를 "무슨 일 · 영향 · 원인 · 먼저 볼 것" 으로 요약해 ops_alerts.ai_summary 에 적습니다.
 *
 * 부르는 곳은 lib/ops-alert-events.ts 하나 — 알림 웹훅에 응답한 **뒤**(after)입니다. Grafana 는
 * 응답이 늦으면 다시 보내므로, 모델을 기다리며 웹훅을 붙잡지 않습니다.
 *
 * ─── 무엇을 근거로 쓰나 ────────────────────────────────────
 * 알림에 실려 온 것(규칙 이름 · 설명 · 라벨 · 평가한 값)과, 이 서버의 고정된 사정(아래 SYSTEM)뿐입니다.
 * 서버에 들어가 지표를 더 읽지는 않습니다 — 그 대신 "먼저 볼 것" 에 서버에서 칠 명령을 줍니다.
 * 명령은 SYSTEM 의 목록에서만 고르게 합니다. 모델이 지어낸 명령을 관리자가 복사해 그대로
 * 치는 일이 없도록, 읽기만 하는 명령만 목록에 둡니다.
 *
 * ─── 숫자는 지어내지 않습니다 ─────────────────────────────
 * 리뷰 요약(lib/review-summary.ts)과 같은 원칙입니다. 평가한 값이 있으면 그 값만 인용하게 합니다.
 *
 * ─── 한도 ─────────────────────────────────────────────────
 * 하루 OPS_ALERT_SUMMARY_LIMIT 번(기본 50). 서버가 흔들리면 규칙 여럿이 몇 분 사이에 함께 울립니다 —
 * 그런 날에도 한도 안에서 앞의 것들은 요약되고, 넘친 것은 규칙 설명으로 보입니다.
 * 입력은 알림 하나에 최대 12,000자(PROMPT_MAX_CHARS)입니다 (GUIDELINES.md §4-7).
 */

/** 리뷰 요약 · 기종 추정과 같은 모델 — 상수를 가져오지 않는 이유는 lib/review-summary.ts 머리말 */
const MODEL = 'gemini-3.7-flash';

/** 모델 한 번을 기다리는 최대 시간. after() 안이라 사용자를 붙잡지는 않지만, 끝없이 기다리지 않게 */
const CALL_TIMEOUT_MS = 30_000;

const schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING, description: '무슨 일인지 한 줄. 40자 이내 해요체' },
    impact: { type: Type.STRING, description: '사이트를 쓰는 사람에게 미치는 영향. 한두 문장' },
    causes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '가능성이 높은 원인. 최대 3개. 알림 내용에 근거가 있는 것만',
    },
    checks: {
      type: Type.ARRAY,
      description: '먼저 볼 것. 최대 4개, 볼 순서대로',
      items: {
        type: Type.OBJECT,
        properties: {
          what: { type: Type.STRING, description: '무엇을 왜 보는지 한 문장' },
          command: { type: Type.STRING, nullable: true, description: '서버에서 칠 명령 — 목록에 있는 것만. 없으면 null' },
        },
        required: ['what', 'command'],
      },
    },
  },
  required: ['headline', 'impact', 'causes', 'checks'],
};

const SYSTEM = `당신은 작은 웹 서비스 "오락실 파인더" 를 혼자 운영하는 개발자를 돕는 당직 엔지니어입니다.
Grafana 가 보낸 알림 하나를 읽고, 휴대폰 알림과 관리자 화면에 띄울 짧은 요약을 만드세요.

서버 사정 (늘 같습니다):
- 네이버 클라우드 서버 1대 — vCPU 1개 · 메모리 1GB · 스왑 1GB · 디스크 10GB · Ubuntu 24.04
- systemd 서비스: arcade-finder(Next.js 앱) · postgresql@18-main(DB) · caddy(HTTPS 앞단)
  · arcade-prometheus-agent · arcade-node-exporter · arcade-postgres-exporter(감시 수집기)
- 배포 묶음(.tgz, 하나에 약 224MB)은 /root 와 /srv/arcade-finder/releases 에 남습니다.
- 사용자는 아직 많지 않습니다(베타).

규칙:
- 한국어 해요체로, 짧게 씁니다.
- headline 은 알림 이름을 옮기지 말고 무슨 일인지 풀어 씁니다. 예: "디스크 여유가 15% 아래로 내려갔어요"
- 알림에 없는 숫자를 지어내지 마세요. "평가한 값" 이 있으면 그 값만 인용하세요. 비율 값(0~1)은 %로 바꿔도 됩니다.
- 영향을 모르면 "영향은 아직 알 수 없어요" 처럼 솔직하게 씁니다.
- checks 의 command 는 아래 목록에서만 고릅니다. 목록에 맞는 것이 없으면 null 로 두고 what 에 말로 씁니다.
  재시작 · 삭제 · 설정 변경 명령은 쓰지 마세요 — 필요하면 what 에 "…를 다시 띄울지 판단" 처럼 말로만.
- "시험 알림" 이면 할 일이 없다고 짧게 알려 주세요.

쓸 수 있는 명령 (읽기만 합니다):
free -m
df -h /
vmstat 1 5
top -b -n 1 | head -20
systemd-cgtop -m -n 1 -b | head -15
grep 'type="ram"' /var/lib/arcade-monitoring/textfile/processes.prom | sort -k2 -nr | head
ls -lh /root/*.tgz /srv/arcade-finder/releases
curl -s 127.0.0.1:3000/api/health
systemctl status arcade-finder --no-pager
journalctl -u arcade-finder -n 50 --no-pager
systemctl status postgresql@18-main --no-pager
journalctl -u postgresql@18-main -n 50 --no-pager
systemctl status caddy --no-pager
journalctl -u caddy -n 50 --no-pager
systemctl status arcade-prometheus-agent arcade-node-exporter arcade-postgres-exporter --no-pager
journalctl -u arcade-prometheus-agent -n 50 --no-pager`;

/** 전송 단계 실패(연결이 안 됨)만 한 번 더 — lib/review-summary.ts isTransportError 와 같은 판단 */
function isTransportError(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/**
 * 요약을 만들어 저장합니다. 만들지 못하면 그 까닭을 ai_error 에 적고 조용히 끝냅니다 —
 * 요약이 없어도 알림 자체(규칙 설명 · 푸시)는 가야 합니다. 이미 요약이 있으면 아무것도 안 합니다.
 */
export async function summarizeAlert(id: number): Promise<void> {
  const alert = await getAlertInput(id);
  if (!alert || alert.hasSummary) return;

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    await saveAlertSummary(id, null, '요약 기능이 꺼져 있어요 (GEMINI_API_KEY 없음)');
    return;
  }
  const quota = await consume('ops-alert-summary:global', limitFromEnv('OPS_ALERT_SUMMARY_LIMIT', 50), DAY_MS);
  if (!quota.allowed) {
    await saveAlertSummary(id, null, '오늘 요약 한도를 다 써서 규칙 설명만 보여 드려요');
    return;
  }

  const prompt = buildAlertPrompt(alert, { recentCount: await countRecentFirings(alert.alertname) });
  // 본문은 남기지 않습니다 — 얼마나 큰 요청이었는지만 (lib/review-summary.ts 와 같은 이유)
  console.info(`[ops-alerts] #${id} ${alert.alertname} 요약 — 입력 ${prompt.length}자 → ${MODEL}`);

  const ai = new GoogleGenAI({ apiKey });
  const call = () =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 1200,
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    });

  try {
    let res: Awaited<ReturnType<typeof call>>;
    try {
      res = await call();
    } catch (err) {
      if (!isTransportError(err)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      res = await call();
    }
    const summary = tidyAi(JSON.parse(res.text ?? '{}'));
    await saveAlertSummary(id, summary, summary ? null : '모델이 쓸 수 있는 요약을 주지 않았어요');
  } catch (err) {
    console.error(`[ops-alerts] #${id} 요약 실패 —`, err instanceof Error ? err.message : err);
    await saveAlertSummary(id, null, '요약을 만들지 못했어요');
  }
}
