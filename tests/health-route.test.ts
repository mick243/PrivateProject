import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 헬스체크 — "살아 있다" 를 **응답 규약대로** 말하는지 봅니다.
 *
 * 예전에는 PostgreSQL → PGlite 폴백을 밖에서 알아채는 것이 이 라우트의 존재 이유였고
 * `degraded` 상태가 있었습니다. 앱이 Prisma 로 옮겨 폴백이 없어졌으므로(lib/prisma.ts)
 * 이제 상태는 healthy · unhealthy 둘입니다. 대신 **모니터링이 보는 키·값의 모양**이
 * 바뀌지 않았는지를 못 박습니다 — Pulse 프로브가 `checks.<이름>` 을 1/0 지표로 편입합니다.
 *
 * DB 는 대역입니다 — 확인하려는 것은 연결이 아니라 **결과를 응답으로 옮기는 규칙**입니다.
 */

let pingImpl: () => Promise<unknown> = async () => [{ ok: 1 }];

vi.mock('@/lib/prisma', () => ({
  getPrismaClient: vi.fn(async () => ({ $queryRawTyped: () => pingImpl() })),
}));

const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  pingImpl = async () => [{ ok: 1 }];
});

describe('GET /api/health', () => {
  it('DB 응답 정상 → 200 healthy, 두 체크 모두 ok', async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks).toEqual({ db: 'ok', db_primary: 'ok' });
    expect(body.db).toEqual({ driver: 'postgres', client: 'prisma', fallback: false });
  });

  it('DB 조회 실패 → 503 unhealthy, 두 체크 모두 fail', async () => {
    pingImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    };
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.checks).toEqual({ db: 'fail', db_primary: 'fail' });
    // 사유에는 DB 호스트·포트가 섞여 있다 — 공개 응답에 나가면 안 된다 (서버 로그에만)
    expect(JSON.stringify(body)).not.toContain('5432');
  });

  it('클라이언트 초기화 자체가 실패해도(DATABASE_URL 없음) unhealthy 로 답한다', async () => {
    const { getPrismaClient } = await import('@/lib/prisma');
    (getPrismaClient as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void })
      .mockImplementationOnce(async () => {
        throw new Error('DATABASE_URL 이 없습니다');
      });
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('unhealthy');
  });

  it('상태 응답은 캐시되면 안 된다', async () => {
    const res = await GET();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('checks 값은 ok | fail 뿐이다 — 프로브가 1/0 지표로 바꾸는 규약', async () => {
    const body = await (await GET()).json();
    for (const v of Object.values(body.checks)) expect(['ok', 'fail']).toContain(v);
  });
});
