import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbStatus } from '@/lib/db';

/**
 * 헬스체크 — "살아 있다" 가 아니라 **어느 DB 로 돌고 있는가**를 맞게 말하는지 봅니다.
 *
 * 이 라우트의 존재 이유는 PostgreSQL → PGlite 폴백을 밖에서 알아채는 것입니다.
 * 폴백 중에도 화면과 쿼리는 멀쩡하므로, 여기서 `degraded` 와 `db_primary: fail` 을
 * 내보내지 않으면 모니터링은 영원히 초록불만 봅니다.
 *
 * DB 는 대역입니다 — 확인하려는 것은 연결이 아니라 **상태를 응답으로 옮기는 규칙**입니다.
 */

let queryImpl: () => Promise<unknown> = async () => ({ rows: [] });
let status: DbStatus = { driver: 'postgres' };

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(async () => ({ query: () => queryImpl() })),
  getDbStatus: vi.fn(() => status),
}));

const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  queryImpl = async () => ({ rows: [] });
  status = { driver: 'postgres' };
});

describe('GET /api/health', () => {
  it('PostgreSQL 정상 → 200 healthy, 두 체크 모두 ok', async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks).toEqual({ db: 'ok', db_primary: 'ok' });
    expect(body.db).toEqual({ driver: 'postgres', fallback: false });
  });

  it('DATABASE_URL 없는 개발 기본(PGlite)은 폴백이 아니다 — healthy', async () => {
    status = { driver: 'pglite' };
    const body = await (await GET()).json();
    expect(body.status).toBe('healthy');
    expect(body.checks.db_primary).toBe('ok');
  });

  it('PostgreSQL → PGlite 폴백 중 → 503 degraded, db_primary 는 fail — 프록시가 트래픽을 빼도록', async () => {
    status = {
      driver: 'pglite',
      fallbackReason: 'connect ECONNREFUSED 127.0.0.1:5432 (ECONNREFUSED)',
      fallbackAt: '2026-09-07T00:00:00.000Z',
    };
    const res = await GET();
    const body = await res.json();
    // 화면은 되지만 이 인스턴스가 쓰는 것은 정본에 남지 않는다 — 프록시가
    // 200 만 보고 트래픽을 보내면 안 되므로 503 이다. 상태 문구는 그대로 degraded.
    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({ db: 'ok', db_primary: 'fail' });
    expect(body.db).toEqual({ driver: 'pglite', fallback: true, fallbackAt: '2026-09-07T00:00:00.000Z' });
    // 사유에는 DB 호스트·포트가 섞여 있다 — 공개 응답에 나가면 안 된다
    expect(JSON.stringify(body)).not.toContain('5432');
  });

  it('DB 조회 실패 → 503 unhealthy, 두 체크 모두 fail', async () => {
    queryImpl = async () => {
      throw new Error('boom');
    };
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.checks).toEqual({ db: 'fail', db_primary: 'fail' });
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
