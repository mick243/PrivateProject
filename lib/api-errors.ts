import { NextResponse } from 'next/server';
import { formatIssues } from './validation';
import type { ZodError } from 'zod';

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

export function fail(status: number, message: string, details?: string[]): NextResponse {
  return NextResponse.json(details ? { error: message, details } : { error: message }, { status });
}

/** 경로의 숫자 id. 양의 정수만 통과합니다 (라우트마다 다시 쓰던 것) */
export function parseId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const badId = (): NextResponse => fail(400, '잘못된 id 입니다');
export const badJson = (): NextResponse => fail(400, 'JSON 본문을 파싱할 수 없습니다');
export const needLogin = (): NextResponse => fail(401, '로그인이 필요합니다');
export const notFound = (message: string): NextResponse => fail(404, message);

/** zod 실패 → 400 + 필드별 문구. 클라이언트가 `data.details` 를 먼저 봅니다 */
export const invalid = (error: ZodError): NextResponse =>
  fail(400, '입력값이 올바르지 않습니다', formatIssues(error));

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
