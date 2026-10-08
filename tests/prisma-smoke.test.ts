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
 * ⚠ 쓰기 함수는 부르지 않습니다(TypedSQL 은 아래 두 번째 묶음이 되돌리며 부릅니다). 대상 DB 는 **사본**이 좋습니다 — 기동
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
      ['arcades.pageArcades (둘째 쪽)', () => arcades.pageArcades({}, { limit: 5, offset: 5 })],
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

/**
 * TypedSQL 전부를 **실 DB 에서 한 번씩** 돌립니다 — 쓰기도 트랜잭션 안에서 부르고 되돌립니다.
 *
 * 위 스모크는 조회 함수만 부릅니다. 그래서 2026-09-28 까지 이관본에 이런 결함이 남아 있었습니다 —
 * `recalc_*` DB 함수가 void 를 돌려주는데 드라이버 어댑터가 void 컬럼을 읽지 못해
 * **투표·클리어·특수패턴·추천·댓글·리뷰 저장이 전부 500** 이었습니다. 타입 생성(`generate --sql`)은
 * 통과했고(`done: string | null`), 단위 테스트는 DB 를 대역으로 세우니 볼 수 없었습니다.
 * 결과를 **역직렬화까지** 해 봐야 드러나는 종류라, 쿼리 파일마다 한 번씩 실제로 부릅니다.
 *
 * 인자는 없는 id 여도 됩니다(0행이면 역직렬화할 행이 없어 약해지지만, 함수 호출·UPSERT 처럼
 * 늘 한 행을 돌려주는 쿼리가 이 검사의 대상입니다). 새 `.sql` 을 더하면 ARGS 에도 더하세요 —
 * 빠뜨리면 첫 번째 단언이 실패합니다.
 */
describe.skipIf(!url)('TypedSQL — 실 DB 에서 한 번씩 (쓰기는 되돌림)', () => {
  it('모든 쿼리의 결과를 역직렬화할 수 있다', async () => {
    process.env.DATABASE_URL = url;
    const { getPrismaClient } = await import('@/lib/prisma');
    const typed = (await import('@/lib/typed-sql')) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const { queryNames } = await import('@/scripts/prisma-typed-sql.mjs');
    const prisma = await getPrismaClient();

    const ARGS: Record<string, unknown[]> = {
      arcadeSearchPage: [37.5665, 126.978, [], [], 5, null, [], 5, 0],
      arcadesWithMachines: [37.5665, 126.978, [], [], 5, null, []],
      consumeRateCounter: ['smoke:typed-sql', 60],
      noteLoginFailure: ['smoke:typed-sql', 15],
      ping: [],
      purgeExpiredQueueReports: [],
      recalcArcadeRating: [1],
      recalcChartStats: [1],
      recalcPostStats: [1],
      tierCharts: [null, null, 1, 'S', 20, false, null],
    };
    expect(Object.keys(ARGS).sort()).toEqual(queryNames());

    class Rollback extends Error {}
    const failed: string[] = [];
    for (const name of queryNames()) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRawTyped(typed[name](...ARGS[name]) as never);
          throw new Rollback(); // 쓰기였어도 남기지 않습니다
        });
      } catch (err) {
        if (err instanceof Rollback) continue;
        const first = String((err as Error).message).split('\n').map((l) => l.trim()).filter(Boolean);
        failed.push(`${name}: ${first.slice(-1)[0] ?? err}`);
      }
    }
    expect(failed).toEqual([]);
  }, 60_000);
});
