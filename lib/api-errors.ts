import { NextResponse } from 'next/server';
import { formatIssues } from './validation';
import type { ZodError, ZodType, output } from 'zod';

/**
 * API 에러 응답을 한 곳에서 만듭니다.
 *
 * ─── 왜 필요했나 ─────────────────────────────────────────────
 * 본문 모양(`{ error: string }`)은 이미 95곳에서 일관됐습니다. 문제는 두 가지였습니다.
 *
 * ① **같은 것을 라우트마다 다시 씁니다.** `parseId` 가 7곳에 재정의돼 있고,
 *    `'잘못된 id 입니다'` 13곳 · `'JSON 본문을 파싱할 수 없습니다'` 19곳 ·
 *    `'입력값이 올바르지 않습니다'` 17곳 · `'로그인이 필요합니다'` 11곳입니다.
 *    문구를 고치려면 60군데를 찾아야 하고, 하나 놓치면 화면에서만 갈립니다.
 *
 * ② **처리되지 않은 에러는 `{ error }` 가 아닙니다.** 실측했습니다 — DB 를 끊고
 *    `/api/arcades` 를 부르면 `HTTP 500` 에 **본문이 비어 있고 `content-type` 도
 *    없습니다.** 그런데 클라이언트는 전부 이렇게 씁니다.
 *
 *      const data = await res.json();          // ← 여기서 던집니다
 *      if (!res.ok) setError(data.error ?? '제보에 실패했습니다');
 *
 *    `res.json()` 이 `if (!res.ok)` 보다 **먼저** 오므로, 정성껏 써 둔 기본 문구는
 *    실행되지 않고 컴포넌트마다 다르게 실패합니다. 사용자는 이유를 못 봅니다.
 *
 * ─── 무엇을 안 하나 ─────────────────────────────────────────
 * **에러 본문에 원인을 담지 않습니다.** 500 은 늘 같은 문구이고 실제 원인은
 * 서버 로그로만 갑니다 — 스택·SQL·연결 문자열이 화면으로 새면 그게 정찰 자료입니다.
 * 사용자가 고칠 수 있는 잘못(입력값·권한·중복)만 구체적으로 말합니다.
 */

/** 500 응답의 문구. 원인은 서버 로그에만 남깁니다 */
const GENERIC_500 = '일시적인 오류입니다. 잠시 후 다시 시도해 주세요';

/** zod 실패의 기본 문구 */
const INVALID = '입력값이 올바르지 않습니다';

/**
 * 실패 응답에 `error` 말고 더 실을 것.
 *
 * 2026-09-28 라우트 전수 정리 때 넣었습니다. 라우트 43개 중 이 파일을 쓰는 것이 7개뿐이었고,
 * 나머지가 손으로 만들던 응답에는 세 가지가 더 붙어 있었습니다 — 그걸 못 싣는 헬퍼는
 * 쓸 수가 없었던 셈입니다.
 */
export interface FailInit {
  /** 필드별 문구 (zod 실패). 폼 화면이 칸마다 보여 줍니다 */
  details?: string[];
  /**
   * 본문에 `error` 와 함께 싣는 값 — 화면이 분기에 쓰는 것
   * (예: 리뷰 요약의 `{ summary: null, reason: 'limit' }`). `error` 는 덮어쓸 수 없습니다.
   */
  extra?: Record<string, unknown>;
  /**
   * 다시 시도해도 되는 때까지 남은 시간(ms) → `Retry-After` 헤더(초, 올림).
   * 한도(429)·일시 중단(503)에 붙입니다 — 클라이언트와 중간 장비가 언제 다시 올지 압니다.
   */
  retryAfterMs?: number;
}

export function fail(status: number, message: string, init?: string[] | FailInit): NextResponse {
  // 세 번째 인자가 배열이던 옛 모양(`fail(400, msg, details)`)도 그대로 받습니다.
  const opts: FailInit = Array.isArray(init) ? { details: init } : (init ?? {});
  const body: Record<string, unknown> = { ...opts.extra, error: message };
  if (opts.details) body.details = opts.details;
  const headers =
    opts.retryAfterMs === undefined
      ? undefined
      : { 'Retry-After': String(Math.ceil(opts.retryAfterMs / 1000)) };
  return NextResponse.json(body, { status, headers });
}

/** 경로의 숫자 id. 양의 정수만 통과합니다 (라우트마다 다시 쓰던 것) */
export function parseId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const badId = (): NextResponse => fail(400, '잘못된 id 입니다');
export const badJson = (): NextResponse => fail(400, 'JSON 본문을 파싱할 수 없습니다');
export const needLogin = (): NextResponse => fail(401, '로그인이 필요합니다');
/** 로그인은 했지만 이 일을 할 권한이 없음 (남의 글·관리자 전용·클리어 게이트) */
export const forbidden = (message: string): NextResponse => fail(403, message);
export const notFound = (message: string): NextResponse => fail(404, message);
/** 상태가 어긋남 — 중복 이름, 그 사이에 바뀐 보유 기종 등. 다시 보내도 같은 답입니다 */
export const conflict = (message: string): NextResponse => fail(409, message);
/** 시도 한도 초과. 남은 시간을 알면 `Retry-After` 로 함께 알려 줍니다 */
export const tooMany = (message: string, retryAfterMs?: number): NextResponse =>
  fail(429, message, { retryAfterMs });
/** 우리 쪽이 지금 받을 수 없음 — 설정 누락·하루 총량 소진. 사용자 잘못이 아닙니다 */
export const unavailable = (message: string, retryAfterMs?: number): NextResponse =>
  fail(503, message, { retryAfterMs });

/**
 * zod 실패의 머리 문구를 무엇으로 할지.
 *
 *   'generic' → '입력값이 올바르지 않습니다' + details. 폼이 details 를 칸마다 보여 줄 때
 *               (ArcadeForm · PostForm · ChartComments · PostDetailView 가 details 를 먼저 봅니다)
 *   'first'   → 첫 번째 문구를 그대로 error 로. details 를 보지 않고 `data.error` 한 줄만
 *               띄우는 화면(/account)용 — "비밀번호는 8자 이상" 이 "입력값이 올바르지
 *               않습니다" 로 뭉개지면 무엇을 고칠지 모릅니다.
 *
 * 어느 쪽이든 details 는 실립니다. 예전에 'first' 모양을 손으로 만들던 라우트 2곳
 * (계정 수정 · 계정 확인)은 details 를 빼고 보냈는데, 더 실어도 그 화면은 모르는 키라 무시합니다.
 * 로그인·가입·닉네임 화면도 details 를 보지 않아 지금은 'generic' 한 줄이 뜹니다 — 'first' 로
 * 바꾸면 안내가 나아지지만 화면 문구가 달라지는 일이라 이번 정리(동작 보존)에서는 두었습니다.
 */
export type IssueHeadline = 'generic' | 'first';

/** zod 실패 → 400 + 필드별 문구. 클라이언트가 `data.details` 를 먼저 봅니다 */
export const invalid = (error: ZodError, headline: IssueHeadline = 'generic'): NextResponse => {
  const details = formatIssues(error);
  return fail(400, headline === 'first' ? (details[0] ?? INVALID) : INVALID, details);
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/**
 * 본문을 JSON 으로 읽습니다. 실패하면 그대로 돌려줄 응답을 함께 줍니다.
 *
 * `requirePlayer` 와 같은 모양(`{ ok, response }`)으로 맞췄습니다 — 라우트 첫 줄들이
 * 같은 리듬으로 읽힙니다.
 */
export async function readJson(request: Request): Promise<Parsed<unknown>> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: badJson() };
  }
}

/**
 * 본문을 읽고 스키마로 검증까지 — 라우트 첫머리의 6줄을 2줄로.
 *
 *   const body = await parseBody(request, postInputSchema);
 *   if (!body.ok) return body.response;
 *   body.value  // ← zod 가 변환·기본값까지 채운 값 (z.output)
 *
 * 2026-09-28 전에는 라우트 파일 18개가 본문을 각자 읽었고(`try { await request.json() } catch`),
 * 그중 10개는 zod 실패 응답까지 손으로 만들어 모양(`details` 유무 · 머리 문구)이 제각각이었습니다.
 */
export async function parseBody<S extends ZodType>(
  request: Request,
  schema: S,
  headline: IssueHeadline = 'generic',
): Promise<Parsed<output<S>>> {
  const raw = await readJson(request);
  if (!raw.ok) return raw;
  const parsed = schema.safeParse(raw.value);
  return parsed.success
    ? { ok: true, value: parsed.data as output<S> }
    : { ok: false, response: invalid(parsed.error, headline) };
}

/**
 * 본문이 **없어도 되는** 요청용 — 빈 본문은 `{}` 로 봅니다 (탈퇴 `DELETE /api/account` 처럼
 * 비밀번호가 없는 소셜 계정은 아무것도 싣지 않습니다). 깨진 JSON 은 여전히 400 입니다.
 */
export async function readOptionalJson(request: Request): Promise<Parsed<unknown>> {
  try {
    const text = await request.text();
    return { ok: true, value: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, response: badJson() };
  }
}

/**
 * Next 가 제어 흐름에 쓰는 예외인가 (`redirect()` · `notFound()`).
 *
 * 이건 **삼켜서는 안 됩니다** — 삼키면 리다이렉트가 500 이 됩니다. 공개 타입이
 * 없어서 `digest` 의 `NEXT_` 접두사로 봅니다(Next 가 그 필드로 표시합니다).
 */
function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_');
}

/**
 * 라우트 핸들러를 감싸, 빠져나온 예외를 **JSON 500** 으로 바꿉니다.
 *
 *   export const GET = handle(async (request) => { … });
 *
 * 이걸 씌우는 이유는 위 ②입니다. 빈 본문 500 이면 클라이언트의 `res.json()` 이
 * 던져서 화면이 이유를 못 보여 줍니다. 모양을 맞춰 주면 이미 쓰여 있는
 * `data.error ?? '…'` 가 그대로 동작합니다.
 *
 * 핸들러가 **의도적으로** 던지던 곳(알 수 없는 DB 오류 등)도 여기로 모입니다 —
 * 그게 목적입니다. 의미가 있는 실패는 핸들러 안에서 4xx 로 돌려주세요.
 */
export function handle<A extends unknown[]>(
  fn: (request: Request, ...args: A) => Promise<Response>,
): (request: Request, ...args: A) => Promise<Response> {
  return async (request, ...args) => {
    try {
      return await fn(request, ...args);
    } catch (err) {
      if (isNextControlFlow(err)) throw err;
      // 원인은 로그로만. 여기에 err.message 를 실으면 내부가 화면으로 나갑니다.
      console.error(`[api] ${request.method} ${new URL(request.url).pathname} —`, err);
      return fail(500, GENERIC_500);
    }
  };
}
