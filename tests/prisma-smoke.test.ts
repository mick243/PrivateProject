import { beforeAll, describe, expect, it } from 'vitest';

/**
 * 실 DB 스모크 — 데이터 계층의 조회 함수가 **실제 PostgreSQL 위에서** 던지지 않고 값을 주는지.
 *
 *   PRISMA_SMOKE_URL="postgresql://…" npm run db:prisma:smoke
 *
 * DB 가 필요하므로 `PRISMA_SMOKE_URL` 이 없으면 통째로 건너뜁니다 — `npm test` 는
 * 지금까지처럼 DB 없이 돕니다.
 *
 * 왜 필요한가: 단위 테스트는 Prisma 를 대역으로 세워 **판정**만 봅니다. 그래서 select 에
 * 없는 필드를 읽는 실수, 관계 이름 오타, TypedSQL 의 파라미터 순서 같은 것은 실 DB 를
 * 만나야 드러납니다. 2026-09-22 에 원시 SQL 121개를 Prisma 로 옮기면서 그 그물로 둔 파일입니다.
 *
 * ⚠ 쓰기 함수는 부르지 않습니다. 읽기만 하고, 대상 DB 는 **사본**이 좋습니다 — 기동
 *   점검이 뷰를 다시 만들기 때문입니다 (lib/prisma.ts bootChecks · 평소 서버가 뜰 때와 같음).
 */
const url = process.env.PRISMA_SMOKE_URL;

describe.skipIf(!url)('Prisma 데이터 계층 스모크', () => {
  const results = new Map<string, { ok: true; value: unknown } | { ok: false; error: string }>();
  let names: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;

    const [arcades, board, tier, reports, reviews, comments, emoticons, favorites, summary, auth] =
      await Promise.all([
        import('@/lib/arcades'),
        import('@/lib/board'),
        import('@/lib/tier'),
        import('@/lib/reports'),
        import('@/lib/reviews'),
        import('@/lib/comments'),
        import('@/lib/emoticons'),
        import('@/lib/favorites'),
        import('@/lib/review-summary'),
        import('@/lib/auth'),
      ]);

    /** 읽기 전용이고, 데이터가 없어도 안전한 인자만 씁니다 */
    const checks: [string, () => Promise<unknown>][] = [
      ['arcades.listArcades (전체)', () => arcades.listArcades({})],
      ['arcades.listArcades (반경)', () => arcades.listArcades({ lat: 37.5665, lng: 126.978, radiusKm: 5 })],
      ['arcades.listArcades (검색)', () => arcades.listArcades({ q: '오락실' })],
      ['arcades.listArcades (기종 AND · 중복 id)', () => arcades.listArcades({ machineIds: [1, 1] })],
      ['arcades.getArcade(1)', () => arcades.getArcade(1)],
      ['arcades.listMachines', () => arcades.listMachines()],
      ['arcades.countMachineGuesses(1)', () => arcades.countMachineGuesses(1)],
      ['arcades.listMachineGuesses(1)', () => arcades.listMachineGuesses(1)],
      ['board.listBoards', () => board.listBoards()],
      ['board.listCategories', () => board.listCategories()],
      ['board.listPosts (최신)', () => board.listPosts({})],
      ['board.listPosts (인기 · 검색)', () => board.listPosts({ sort: 'popular', q: '펌프' })],
      ['board.listNews(3)', () => board.listNews(3)],
      ['board.getPost(1)', () => board.getPost(1, null)],
      ['tier.getSettings', () => tier.getSettings()],
      ['tier.getGrades', () => tier.getGrades()],
      ['tier.listGames', () => tier.listGames()],
      ['tier.listLevels', () => tier.listLevels()],
      ['tier.getTierBoard', () => tier.getTierBoard({ mode: 'S', level: 20, playerId: null })],
      ['tier.getTierBoard (미상 레벨)', () => tier.getTierBoard({ mode: 'S', level: null, playerId: null })],
      ['tier.getChartDetail(1)', () => tier.getChartDetail(1, null)],
      ['reports.getReportSettings', () => reports.getReportSettings()],
      ['reports.listReports', () => reports.listReports({ sinceHours: 24, q: '펌프' })],
      ['reviews.listReviews(1)', () => reviews.listReviews(1)],
      ['comments.listComments(1)', () => comments.listComments(1)],
      ['emoticons.listEmoticons', () => emoticons.listEmoticons()],
      ['emoticons.listEmoticonsForAdmin', () => emoticons.listEmoticonsForAdmin(emoticons.normalizeAdminQuery({}))],
      ['favorites.listFavoriteIds(1)', () => favorites.listFavoriteIds(1)],
      ['review-summary.lookupReviewSummary(1)', () => summary.lookupReviewSummary(1)],
      ['auth.loginLockRemainingMs', () => auth.loginLockRemainingMs('account:smoke')],
      ['auth.nicknameStatus(1)', () => auth.nicknameStatus(1)],
    ];
    names = checks.map(([name]) => name);

    for (const [name, fn] of checks) {
      try {
        results.set(name, { ok: true, value: await fn() });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        results.set(name, { ok: false, error: `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}` });
      }
    }
  }, 120_000);

  it('던진 조회가 없다', () => {
    const threw = names
      .map((n) => [n, results.get(n)!] as const)
      .filter(([, r]) => !r.ok)
      .map(([n, r]) => ({ name: n, error: (r as { error: string }).error }));
    expect(threw).toEqual([]);
  });

  it('응답을 JSON 으로 만들 수 있다 — BigInt·Decimal 이 새지 않았다', () => {
    const leaked: string[] = [];
    for (const n of names) {
      const r = results.get(n)!;
      if (!r.ok) continue;
      try {
        const text = JSON.stringify(r.value);
        // 매핑을 빠뜨리면 DB 컬럼 이름(snake_case)이 그대로 응답에 남는다 — 도메인 타입은 camelCase 다.
        if (/"(rating_avg|avg_vote|review_count|vote_count|created_at)":/.test(text)) {
          leaked.push(`${n}: 원시 컬럼 이름이 응답에 남음`);
        }
      } catch (err) {
        leaked.push(`${n}: ${(err as Error).message}`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('빈 답만 돌아온 것이 아니다 — 대상 DB 에 데이터가 있어야 스모크가 의미를 갖는다', () => {
    const empty = new Set(['[]', 'null', '{}', 'undefined', '0']);
    const withData = names.filter((n) => {
      const r = results.get(n)!;
      return r.ok && !empty.has(JSON.stringify(r.value) ?? 'undefined');
    });
    expect(withData.length).toBeGreaterThan(names.length / 2);
  });
});
