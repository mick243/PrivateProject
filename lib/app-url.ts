/**
 * 바깥에서 보이는 앱 주소 (metadata · robots · sitemap · OG).
 *
 * 운영에서는 APP_URL 이 필수입니다(lib/env-check.ts). 빌드 시점·개발에서는 없을 수
 * 있어 localhost 로 떨어집니다 — 그 값이 sitemap 에 박히면 안 되므로 운영은 반드시
 * 채우세요. OAuth 콜백 주소도 같은 값을 씁니다 (lib/oauth.ts).
 */
export function publicAppUrl(): string {
  const raw = process.env.APP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return 'http://localhost:3000';
}

/**
 * 요청 기준의 바깥 주소 — **밖으로 나갔다가 돌아오는 길**을 만들 때 씁니다.
 * OAuth 콜백(lib/oauth.ts redirectUri)과 인증 메일의 링크(lib/email-verify.ts)가
 * 그렇습니다. 둘이 서로 다른 방식으로 주소를 짐작하면 한쪽만 조용히 어긋납니다.
 *
 * 위 publicAppUrl 과 나눠 둔 이유: 그쪽은 요청이 없는 자리(metadata·sitemap·OG)에서
 * 불리므로 APP_URL 하나만 봅니다. 여기는 요청이 있어 헤더로 유추할 수 있지만,
 * 그건 **마지막 수단**입니다 — 프록시 뒤에서는 Host 가 내부 주소일 수 있고, 그러면
 * OAuth 는 등록해 둔 주소와 달라 실패하고 메일 링크는 열 수 없는 주소로 나갑니다.
 * 운영에서는 APP_URL 을 못박으세요 (lib/env-check.ts 가 없으면 기동을 막습니다).
 */
export function appOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? request.headers.get('host');
  if (host) return `${proto || 'http'}://${host}`;
  return new URL(request.url).origin;
}

/**
 * 라우트에서 **우리 화면으로 돌려보내는** 주소 (`NextResponse.redirect` 의 인자).
 *
 * `new URL(path, request.url)` 로 만들면 안 됩니다. `next start -H 127.0.0.1 -p 3001`
 * 뒤에서는 request.url 이 Host 헤더가 아니라 **Next 가 붙은 주소**로 만들어져서
 * (`https://localhost:3001/…`), 브라우저가 그 주소로 튕겨 나갑니다. 실서버에서
 * 소셜 로그인이 끝나자마자 "연결할 수 없음" 이 뜬 원인이 이것입니다 (2026-10-01).
 * 개발 서버는 내부 주소와 바깥 주소가 같아서 드러나지 않습니다.
 */
export function appUrl(request: Request, path: string): URL {
  return new URL(path, appOrigin(request));
}
