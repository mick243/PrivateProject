import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

/**
 * API 응답 압축.
 *
 * **왜 앱이 하나** — Next 는 `next start` 에서 렌더된 HTML 과 정적 파일만 gzip 합니다
 * (`node_modules/next/dist/docs/.../compress.md`). 라우트 핸들러가 돌려주는 JSON 은
 * 그 경로를 타지 않아서 **압축 없이 그대로 나갑니다.** 직접 확인했습니다 —
 * 같은 서버에서 `/` 는 `Content-Encoding: gzip`, `/api/arcades` 는 헤더 자체가 없습니다.
 *
 * 목표 규모(가입자 10,000 · DAU 3,000)에서 이게 가장 큰 항목입니다. `/api/arcades`
 * 하나가 기종 데이터를 채운 상태에서 **1.2MB** 이고, 세션마다 한 번 나갑니다.
 * 하루 4,500 세션이면 5.4GB/일 입니다. 압축하면 같은 응답이 1/8 이 됩니다.
 *
 * **왜 동기 압축이 아닌가** — PERFORMANCE.md 2부가 이 앱의 병목을 이벤트 루프 지연으로
 * 짚었습니다. `gzipSync` 는 1.2MB 에 10ms 넘게 루프를 잡아먹어서, 바이트를 아끼려다
 * 그 병목을 키웁니다. zlib 의 비동기 API 는 libuv 스레드풀에서 도니 루프가 안 멈춥니다.
 *
 * **프록시를 앞에 두면** — nginx·caddy 가 압축을 맡는 것이 정석이고 그때는 이 계층이
 * 중복입니다. `API_COMPRESSION=off` 로 끄세요. 지금은 프록시가 없어서 앱이 합니다.
 */
const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/**
 * 이 크기 아래로는 압축하지 않습니다. 1,400바이트는 이더넷 MTU 안에 들어가는
 * 크기라, 더 줄여도 왕복 수가 줄지 않으면서 CPU 만 씁니다.
 */
const MIN_BYTES = 1400;

/**
 * gzip level 6(기본)은 1.2MB 에 3.3ms 인데 level 1 은 1.5ms 로 크기 차이가 8KB 뿐입니다.
 * brotli q4 는 2.0ms 에 gzip level 9 보다 작습니다 — 재서 고른 값입니다.
 *   원본 299KB → gzip1 56.7KB(1.49ms) · gzip6 48.2KB(3.32ms) · br q4 46.3KB(2.02ms)
 */
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

type Encoding = 'br' | 'gzip' | null;

/**
 * Node 의 Buffer 를 표준 `Response` 에 그대로 넘기면 TS 가 `BodyInit` 로 안 받아 줍니다.
 * 같은 메모리를 가리키는 Uint8Array 뷰로 감싸고, 응답은 `NextResponse` 로 만듭니다 —
 * 첨부 다운로드(app/api/uploads/[id])가 이미 쓰고 있는 방식과 같습니다.
 */
const asBody = (buf: Buffer): Uint8Array<ArrayBuffer> =>
  // 제네릭 인자가 중요합니다 — `Uint8Array<ArrayBufferLike>` 는 SharedArrayBuffer 를
  // 포함해서 BodyInit 이 안 받습니다. Buffer 는 풀에서 잘라 쓸 수 있으므로
  // offset·length 를 반드시 같이 넘겨야 합니다 (복사는 일어나지 않습니다).
  new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);

/** 클라이언트가 받아 주는 것 중 가장 좋은 것을 고릅니다. */
function negotiate(request: Request): Encoding {
  const accept = request.headers.get('accept-encoding') ?? '';
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function enabled(): boolean {
  return process.env.API_COMPRESSION !== 'off';
}

/**
 * 거의 바뀌지 않는 참조 데이터에 붙이는 캐시 지시.
 *
 * 지침서가 압축보다 효과가 크다고 적어 둔 항목입니다 — 압축은 바이트를 줄이지만
 * 캐시는 **왕복 자체를 없앱니다.** 기종 마스터·게시판 말머리·서열표 게임 목록은
 * 마이그레이션으로만 바뀌는데도 매 요청 DB 를 거쳐 나가고 있었습니다.
 *
 * `private` 인 이유: 값 자체는 누구에게나 같지만, 중간 캐시(회사 프록시 등)가
 * 우리 응답을 들고 있다가 다른 사람에게 주는 상황을 만들 이유가 없습니다. 브라우저
 * 하나만 캐시해도 왕복은 사라집니다.
 *
 * `stale-while-revalidate` 는 만료 직후 한 번은 낡은 값을 바로 주고 뒤에서 갱신하라는
 * 뜻입니다 — 첫 화면에서 기종 칩이 잠깐 비는 것을 막습니다.
 *
 * ⚠ **세션에 따라 내용이 달라지는 응답에는 절대 쓰지 마세요.** 서열표(`/api/tier`)는
 * 내 클리어·내 투표가 섞여 나오므로 대상이 아닙니다.
 */
export const REFERENCE_CACHE = 'private, max-age=300, stale-while-revalidate=3600';

/** 본문 해시로 만든 약한 ETag — 같은 내용이면 같은 값 */
function etagOf(raw: Buffer): string {
  return `W/"${createHash('sha1').update(raw).digest('base64url')}"`;
}

/**
 * `NextResponse.json` 자리에 그대로 넣을 수 있는 압축판입니다.
 * 압축을 못 하거나 안 하는 경우에도 **같은 JSON 을 같은 상태코드로** 돌려줍니다.
 *
 * `init.headers` 에 `Cache-Control` 이 있으면 ETag 를 함께 붙이고, 클라이언트가
 * `If-None-Match` 로 같은 값을 보내면 **본문 없이 304** 를 돌려줍니다.
 */
export async function json(
  request: Request,
  data: unknown,
  init?: ResponseInit,
): Promise<Response> {
  const body = JSON.stringify(data);
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');

  /**
   * 압축 여부가 Accept-Encoding 에 따라 갈리므로 Vary 를 반드시 붙입니다.
   * 없으면 중간 캐시가 gzip 본문을 압축을 모르는 클라이언트에게 줄 수 있습니다.
   */
  headers.set('Vary', 'Accept-Encoding');

  const raw = Buffer.from(body, 'utf8');

  // 캐시하라고 표시한 응답에만 ETag 를 붙인다 — 매번 바뀌는 목록에 붙이면 해시
  // 계산만 늘고 304 는 안 나온다.
  if (headers.has('Cache-Control')) {
    const etag = etagOf(raw);
    headers.set('ETag', etag);
    if (request.headers.get('if-none-match') === etag) {
      // 304 에는 본문이 없다. Content-Length/Encoding 을 남기면 안 된다.
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      return new NextResponse(null, { ...init, status: 304, headers });
    }
  }

  const encoding = enabled() && raw.byteLength >= MIN_BYTES ? negotiate(request) : null;

  if (!encoding) {
    headers.set('Content-Length', String(raw.byteLength));
    return new NextResponse(asBody(raw), { ...init, headers });
  }

  let packed: Buffer;
  try {
    packed =
      encoding === 'br'
        ? await brotli(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
            },
          })
        : await gzip(raw, { level: GZIP_LEVEL });
  } catch (err) {
    // 압축 실패가 응답 실패가 되면 안 됩니다 — 원본으로 내려보냅니다.
    console.error('[http] 응답 압축 실패 —', (err as Error).message);
    headers.set('Content-Length', String(raw.byteLength));
    return new NextResponse(asBody(raw), { ...init, headers });
  }

  headers.set('Content-Encoding', encoding);
  headers.set('Content-Length', String(packed.byteLength));
  return new NextResponse(asBody(packed), { ...init, headers });
}
