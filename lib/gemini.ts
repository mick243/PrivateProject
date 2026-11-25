import { ApiError, GoogleGenAI } from '@google/genai';

/**
 * Gemini 를 부르는 곳(챗봇 · 리뷰 요약 · 기종 추정 · 운영 알림 요약)이 함께 쓰는 것들.
 *
 * 2026-11-25 전에는 모델 이름 · 키 읽기 · 연결 실패 판단이 파일마다 따로 적혀 있었습니다.
 * 그 사이 `gemini-3.7-flash` 가 지원 종료되어 요청이 조용히 `gemini-3.8-flash` 로 넘어가고
 * 있었고(응답의 modelVersion 으로 확인), 3.8 은 2027-01-01 부터 값이 두 배입니다. 모델을
 * 바꾸려면 다섯 곳을 고쳐야 했습니다 — 그래서 이름을 여기 하나로 모으고 환경변수로 뺍니다.
 *
 * scripts/guess-arcade-machines.mjs 는 .ts 를 불러올 수 없어 같은 기본값을 따로 적습니다.
 * 기본값을 바꾸면 그쪽도 같이 바꾸세요.
 */

/**
 * 기본 모델.
 *
 * 2026-11-25 에 3.7-flash(실제로는 3.8-flash)와 같은 요청으로 비교했습니다 — 함수 호출과
 * 구글 검색을 한 요청에 섞기(챗봇), 검색만(기종 추정), JSON 스키마(요약 · 추정 2차),
 * 이미지 입력(리뷰 이모티콘), 범위 밖 질문 · 지시 무시 요구 거절, "최신 버전" 을 검색으로
 * 확인하기가 모두 같게 됐고 응답은 2~5배 빨랐습니다. 값은 입력 $0.30 · 출력 $2.50(1M 토큰)으로
 * 3.8-flash 의 40~67% 입니다.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

/** 지금 쓸 모델 이름. `GEMINI_MODEL` 로 바꿀 수 있습니다 (배포 없이 되돌리기용). */
export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/** 키가 없으면 null — 그 기능만 꺼지고 앱 본체는 그대로 돕니다. */
export function geminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}

/**
 * 모델 한 번을 기다리는 최대 시간(ms).
 *
 * 없으면 응답이 오지 않는 호출이 fetch 기본값(약 300초)까지 매달립니다. 운영 서버는
 * 1GB · 프로세스 1개라, 그런 요청이 쌓이면 서버 전체가 느려집니다 (SSOT R29).
 * 값은 2026-11-25 실측의 여러 배로 잡았습니다 — 챗봇 한 왕복 1~5초, 검색이 붙은 기종
 * 추정 4~36초.
 */
export const GEMINI_TIMEOUT_MS = {
  /** 챗봇 왕복 한 번 */
  chatStep: 30_000,
  /** 챗봇 요청 하나 전체 (왕복 전부). route 의 maxDuration(120초)보다 짧게 */
  chatTotal: 90_000,
  /** 리뷰 요약 한 번 (그림 포함) */
  summary: 40_000,
  /** 기종 추정 — 1차는 검색이 여러 번 돕니다 */
  guessSearch: 60_000,
  guessShape: 30_000,
  /** 운영 알림 요약 (응답 뒤 after() 안) */
  opsAlert: 30_000,
} as const;

/** `config.abortSignal` 에 넣을 시간 제한 신호. 호출마다 새로 만들어야 합니다 (다시 보낼 때도). */
export function geminiTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * 실패를 원인별로 나눕니다. 사용자 문구는 부르는 쪽이 정하고, 여기는 로그와 분기에 씁니다.
 *
 * - key     키가 틀림 · 권한 없음 (401 · 403, 잘못된 키는 400 으로도 옵니다)
 * - credit  선불 크레딧이 바닥남 (402) — SSOT R32. 키는 맞으므로 따로 봐야 합니다
 * - model   이 키로 그 모델을 못 씀 · 모델 이름이 없음 (404)
 * - rate    분당 · 하루 한도 (429)
 * - timeout 우리가 건 시간 제한에 걸림 (AbortError / TimeoutError)
 * - network 연결 자체가 안 됨 (fetch 의 TypeError)
 * - other   그 밖
 */
export type GeminiFailure = 'key' | 'credit' | 'model' | 'rate' | 'timeout' | 'network' | 'other';

export function classifyGeminiError(err: unknown): GeminiFailure {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return 'key';
    if (err.status === 400 && /api key/i.test(err.message)) return 'key';
    if (err.status === 402) return 'credit';
    if (err.status === 404) return 'model';
    if (err.status === 429) return 'rate';
    return 'other';
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  // SDK 는 네트워크 실패를 전용 오류로 감싸지 않고 fetch 의 것을 그대로 던집니다.
  if (err instanceof TypeError) return 'network';
  return 'other';
}

/**
 * 같은 요청을 한 번 더 보내 볼 만한 실패인지 — 연결 단계에서 끊긴 것만.
 * API 가 거절한 것(400 · 429 등)과 시간 초과는 다시 보내도 같거나 더 오래 걸립니다.
 */
export function isTransportError(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** 서버 로그용 한 줄 — 무엇을 고쳐야 하는지. 사용자 화면에는 내지 않습니다. */
export function describeGeminiFailure(kind: GeminiFailure, model = geminiModel()): string {
  switch (kind) {
    case 'key':
      return 'Gemini 가 키를 거절했습니다 — GEMINI_API_KEY 를 확인하세요';
    case 'credit':
      return 'Gemini 크레딧이 바닥났습니다 (402) — AI Studio 결제 화면에서 충전하세요';
    case 'model':
      return `이 키로는 ${model} 을 쓸 수 없습니다 (404) — GEMINI_MODEL 을 확인하세요`;
    case 'rate':
      return 'Gemini 한도에 걸렸습니다 (429)';
    case 'timeout':
      return 'Gemini 응답이 시간 제한을 넘겼습니다';
    case 'network':
      return 'Gemini 에 연결하지 못했습니다';
    default:
      return 'Gemini 호출이 실패했습니다';
  }
}
