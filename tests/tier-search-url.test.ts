import { describe, expect, it, vi } from 'vitest';
import {
  CHART_SEARCH_MAX_QUERY,
  chartStepLabel,
  normalizeChartQuery,
  sortSongCharts,
} from '@/lib/chart-search-types';
import type { ChartSearchChart } from '@/lib/chart-search-types';
import { parseTierQuery, sameSelection, tierQuery } from '@/lib/tier-url';
import { UNKNOWN_LEVEL } from '@/lib/tier-types';

/**
 * 서열표 곡 검색 · 주소 (UX 시험 2026-11-20 T-1 · C-1).
 *
 * 화면이 쓰는 순수 함수와, 검색 API 의 입력 검사를 봅니다. 검색 질의 자체(Prisma)는 대역으로
 * 세웁니다 — 확인하려는 것은 "무엇을 넘기고 무엇을 거르는가" 입니다.
 */

const chart = (over: Partial<ChartSearchChart>): ChartSearchChart => ({
  id: 1,
  mode: null,
  difficulty: null,
  level: 1,
  versionId: null,
  ...over,
});

describe('normalizeChartQuery', () => {
  it('앞뒤 공백을 걷고 가운데 공백을 하나로 줄인다', () => {
    expect(normalizeChartQuery('  Night   Duty ')).toBe('Night Duty');
  });
  it('비었거나 공백뿐이면 null — 검색하지 않는다', () => {
    expect(normalizeChartQuery('')).toBeNull();
    expect(normalizeChartQuery('   ')).toBeNull();
    expect(normalizeChartQuery(null)).toBeNull();
  });
  it('상한까지만 쓴다', () => {
    expect(normalizeChartQuery('a'.repeat(200))).toHaveLength(CHART_SEARCH_MAX_QUERY);
  });
});

describe('sortSongCharts — 게임이 정한 순서', () => {
  const pump = {
    modes: [
      { code: 'S', label: 'Single' },
      { code: 'D', label: 'Double' },
    ],
    difficulties: [],
  };

  it('모드는 알파벳이 아니라 게임 순서(S 가 D 보다 먼저), 그 안에서 레벨 오름차순', () => {
    const sorted = sortSongCharts(
      [
        chart({ id: 1, mode: 'D', level: 21 }),
        chart({ id: 2, mode: 'S', level: 22 }),
        chart({ id: 3, mode: 'S', level: 20 }),
      ],
      pump,
    );
    expect(sorted.map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it('레벨 미상은 끝, 등록되지 않은 모드는 뒤로 밀되 빼지 않는다', () => {
    const sorted = sortSongCharts(
      [
        chart({ id: 1, mode: 'S', level: null }),
        chart({ id: 2, mode: 'CO', level: 2 }),
        chart({ id: 3, mode: 'S', level: 5 }),
      ],
      pump,
    );
    expect(sorted.map((c) => c.id)).toEqual([3, 1, 2]);
  });

  it('난이도 축(EZ2DJ)은 난이도 순서표를 따른다', () => {
    const ez = {
      modes: [{ code: '7ST', label: '7 Street' }],
      difficulties: [
        { code: 'NM', label: 'NM' },
        { code: 'HD', label: 'HD' },
      ],
    };
    const sorted = sortSongCharts(
      [
        chart({ id: 1, mode: '7ST', difficulty: 'HD', level: 9 }),
        chart({ id: 2, mode: '7ST', difficulty: 'NM', level: 12 }),
      ],
      ez,
    );
    expect(sorted.map((c) => c.id)).toEqual([2, 1]);
  });
});

describe('chartStepLabel', () => {
  it('모드 표기 + 난이도 + 레벨', () => {
    const game = { modes: [{ code: '7ST', label: '7 Street' }] };
    expect(chartStepLabel(chart({ mode: '7ST', difficulty: 'HD', level: 12 }), game)).toBe(
      '7 Street HD Lv.12',
    );
  });
  it('게임을 모르면 코드, 레벨 미상은 Lv.?', () => {
    expect(chartStepLabel(chart({ mode: 'S', level: null }))).toBe('S Lv.?');
  });
});

describe('서열표 주소 (lib/tier-url.ts)', () => {
  it('주소 → 상태 → 주소 가 같은 주소로 돌아온다 (공유 · 새로고침)', () => {
    const q = 'machineId=1&mode=S&level=20&chart=123';
    const st = parseTierQuery(`?${q}`);
    expect(st).toEqual({
      sel: { machineId: 1, versionId: null, mode: 'S', level: 20 },
      chartId: 123,
    });
    expect(tierQuery(st)).toBe(q);
  });

  it('레벨 미상 칸은 unknown 으로 오간다', () => {
    const st = parseTierQuery('?machineId=10&versionId=2&mode=7ST&level=unknown');
    expect(st.sel.level).toBe(UNKNOWN_LEVEL);
    expect(tierQuery(st)).toBe('machineId=10&versionId=2&mode=7ST&level=unknown');
  });

  it('이상한 값은 버린다 — 서버가 기본 조합을 고르고, 패널은 열지 않는다', () => {
    const st = parseTierQuery('?machineId=abc&level=1.5&chart=-3&mode=');
    expect(st).toEqual({
      sel: { machineId: null, versionId: null, mode: null, level: null },
      chartId: null,
    });
    expect(parseTierQuery('?chart=').chartId).toBeNull();
  });

  it('비어 있는 칸은 주소에 적지 않는다', () => {
    expect(
      tierQuery({
        sel: { machineId: 3, versionId: null, mode: null, level: 17 },
        chartId: null,
      }),
    ).toBe('machineId=3&level=17');
  });

  it('sameSelection 은 표를 정하는 네 값만 본다', () => {
    const a = { machineId: 1, versionId: null, mode: 'S', level: 20 as const };
    expect(sameSelection(a, { ...a })).toBe(true);
    expect(sameSelection(a, { ...a, level: 21 })).toBe(false);
  });
});

describe('GET /api/charts/search — 입력 검사', () => {
  it('게임 · 검색어가 없으면 400, 있으면 다듬은 검색어로 찾는다', async () => {
    const calls: unknown[] = [];
    vi.doMock('@/lib/chart-search', async () => {
      const types = await import('@/lib/chart-search-types');
      return {
        normalizeChartQuery: types.normalizeChartQuery,
        searchChartSongs: async (p: unknown) => {
          calls.push(p);
          return [];
        },
      };
    });
    const { GET } = await import('@/app/api/charts/search/route');
    const call = (qs: string) =>
      GET(new Request(`http://localhost/api/charts/search?${qs}`)) as Promise<Response>;

    const noGame = await call('q=night');
    expect(noGame.status).toBe(400);
    expect((await noGame.json()).error).toBe('게임을 먼저 골라 주세요');

    const noQuery = await call('machineId=1&q=%20%20');
    expect(noQuery.status).toBe(400);
    expect((await noQuery.json()).error).toBe('찾을 곡 이름을 적어 주세요');
    expect(calls).toEqual([]);

    const ok = await call('machineId=10&versionId=2&q=%20night%20%20duty');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ q: 'night duty', songs: [] });
    expect(calls).toEqual([{ machineId: 10, versionId: 2, q: 'night duty' }]);
    vi.doUnmock('@/lib/chart-search');
  });
});

describe('GET /api/charts/:id/siblings', () => {
  it('번호가 이상하면 400, 없는 채보면 404, 있으면 곡의 채보 목록', async () => {
    vi.doMock('@/lib/chart-search', () => ({
      listSongCharts: async (id: number) =>
        id === 7
          ? {
              songId: 3,
              title: 'Night Duty',
              charts: [chart({ id: 7, mode: 'S', level: 20 })],
            }
          : null,
    }));
    const { GET } = await import('@/app/api/charts/[id]/siblings/route');
    const call = (id: string) =>
      GET(new Request(`http://localhost/api/charts/${id}/siblings`), {
        params: Promise.resolve({ id }),
      }) as Promise<Response>;

    expect((await call('abc')).status).toBe(400);
    const missing = await call('8');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('채보를 찾을 수 없어요');
    const ok = await call('7');
    expect(ok.status).toBe(200);
    expect((await ok.json()).title).toBe('Night Duty');
    vi.doUnmock('@/lib/chart-search');
  });
});
