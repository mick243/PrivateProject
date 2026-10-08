/**
 * 챗봇이 쓰는 **앱 안쪽 도구들**.
 *
 * 모델에게 이 앱의 DB 를 통째로 열어 주는 대신, 화면이 이미 쓰고 있는 조회
 * 함수(lib/arcades.ts · lib/reports.ts · lib/board.ts)를 그대로 감싸 세 개만
 * 내줍니다. 같은 함수를 쓰므로 **챗봇이 말하는 값과 화면에 뜨는 값이 어긋날
 * 수 없습니다** — 챗봇 전용 SQL 을 따로 쓰면 집계 규칙이 두 벌이 됩니다.
 *
 * 반환값은 모델이 읽을 요약 JSON 입니다. 전체 레코드를 그대로 실으면 한 번
 * 검색에 수십 KB 가 들어가 대화가 금방 컨텍스트를 넘깁니다.
 *
 * ─── 쪽 나누기 (2026-09-28) ──────────────────────────────────────
 * 한 번에 PAGE_SIZE 건만 돌려주고, 더 있으면 `hasMore: true` 로 알립니다. 모델은 필요할 때만
 * `page` 를 올려 다음 묶음을 부릅니다 — 모델이 읽는 양(토큰)을 질문이 요구하는 만큼으로 묶는
 * 장치입니다. 자르기는 **DB 에서** 합니다. 예전에는 오락실 도구가 조건에 맞는 곳을 전부
 * 집계한 뒤 앞의 8곳만 썼습니다(목표 규모에서 기종 하나로 찾으면 926곳 · 28.5ms).
 * 한 요청이 도구 결과로 모델에 돌려줄 수 있는 누적 분량은 라우트가 따로 막습니다
 * (lib/chat-budget.ts TOOL_OUTPUT_CHAR_BUDGET).
 *
 * ⚠ 서버 전용입니다 (getPrismaClient → pg). 클라이언트에서 import 하지 마세요.
 */

import { listMachines, pageArcades } from './arcades';
import { listPosts } from './board';
import { listReports } from './reports';
import type { ReportKind } from './community-types';
import type { Arcade } from './types';

/** 도구 한 번이 돌려주는 건수 — 모델이 읽을 분량을 묶는 단위 */
export const PAGE_SIZE = 5;
/** 쪽 번호 상한. 모델이 끝없이 넘기지 않게 (5 × 20 = 100건까지) */
export const MAX_PAGE = 20;
/** 메모·본문 발췌를 모델에 넘길 때의 글자 상한 */
const NOTE_CHARS = 120;

/** 모델이 준 page 를 1…MAX_PAGE 로 */
export function pageOf(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_PAGE) : 1;
}

/** 모든 도구가 같은 모양으로 쪽 정보를 붙입니다 — 모델이 한 번 배우면 셋 다 넘길 수 있게 */
function pageInfo(page: number, hasMore: boolean, total?: number | null) {
  return {
    page,
    pageSize: PAGE_SIZE,
    ...(total === undefined || total === null ? {} : { total }),
    hasMore: hasMore && page < MAX_PAGE,
  };
}

const clip = (s: string | null | undefined, max = NOTE_CHARS) =>
  s ? (s.length > max ? `${s.slice(0, max)}…` : s) : undefined;

/**
 * "펌프" · "Pump It Up" · "PIU" 중 무엇으로 물어도 같은 기종을 찾습니다.
 * 모델이 기종 id 를 알 리 없으므로 이름으로 받고 여기서 옮깁니다.
 */
async function resolveMachineIds(name: string | null | undefined): Promise<number[]> {
  if (!name || !name.trim()) return [];
  const needle = name.trim().toLowerCase();
  const machines = await listMachines();
  const hit = machines.filter(
    (m) =>
      m.name.toLowerCase().includes(needle) ||
      m.shortName.toLowerCase().includes(needle) ||
      needle.includes(m.shortName.toLowerCase()),
  );
  return hit.map((m) => m.id);
}

function hoursOf(a: Arcade): string {
  if (a.is24h) return '24시간';
  if (a.openTime && a.closeTime) return `${a.openTime}~${a.closeTime}`;
  return '미등록';
}

/** 오락실 1건을 모델이 읽을 만큼만 납작하게. 비어 있는 칸은 싣지 않습니다(JSON 에서 빠짐) */
export function summarizeArcade(a: Arcade) {
  return {
    name: a.name,
    address: a.address,
    hours: hoursOf(a),
    rating: a.ratingAvg === null ? undefined : `${a.ratingAvg.toFixed(1)} (${a.reviewCount}건)`,
    machines: a.machines.map((m) => {
      // 화면과 같은 값 — 등록값과 제보를 종합해 뷰가 반올림한 정수입니다.
      const condition = m.cabinets
        .map((c) => c.conditionSummary?.value ?? null)
        .filter((v): v is number => v !== null);
      return {
        name: m.name,
        cabinets: m.cabinetCount,
        condition: condition.length ? condition : undefined,
        // 수명 안의 제보가 없으면 아예 담지 않습니다. 0 으로 채우면
        // "지금 줄 없음" 이라는 없는 정보가 생깁니다.
        waitNow: m.live?.waitCount ?? undefined,
      };
    }),
    note: clip(a.note),
  };
}

export interface ArcadeSearchArgs {
  query?: string | null;
  machine?: string | null;
  page?: number | null;
}

export async function searchArcades(args: ArcadeSearchArgs): Promise<unknown> {
  const machineIds = await resolveMachineIds(args.machine);
  if (args.machine && machineIds.length === 0) {
    return { error: `'${args.machine}' 이라는 기종을 찾지 못했습니다`, arcades: [] };
  }
  const page = pageOf(args.page);
  const { arcades, total } = await pageArcades(
    { q: args.query ?? null, machineIds: machineIds.length ? machineIds : null },
    { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
  );

  return {
    ...pageInfo(page, total !== null && page * PAGE_SIZE < total, total),
    // 좌표 기준 조회가 아니므로 거리는 없습니다 — 순위는 지도 화면이 냅니다.
    arcades: arcades.map(summarizeArcade),
  };
}

export interface ReportSearchArgs {
  machine?: string | null;
  kind?: ReportKind | null;
  sinceHours?: number | null;
  page?: number | null;
}

/**
 * 실시간 제보 피드 (/live 와 같은 소스).
 *
 * 대기 제보는 4시간 뒤에 실제로 삭제되므로(lib/reports.ts), 여기서 안 나온다는
 * 것은 "줄이 없다" 가 아니라 "최근 제보가 없다" 입니다. 그 차이를 모델이
 * 헷갈리지 않게 응답에 적어 둡니다.
 */
export async function searchReports(args: ReportSearchArgs): Promise<unknown> {
  const machineIds = await resolveMachineIds(args.machine);
  const page = pageOf(args.page);
  // 하나 더 읽어 다음 쪽이 있는지 압니다 — 피드는 전체 수를 세지 않습니다(최신순 · 계속 바뀜).
  const rows = await listReports({
    machineId: machineIds[0] ?? null,
    kinds: args.kind ? [args.kind] : null,
    sinceHours: args.sinceHours ?? 24,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });
  const reports = rows.slice(0, PAGE_SIZE);

  return {
    note: '제보가 없다는 것은 "상태가 좋다"가 아니라 "최근 제보가 없다"는 뜻입니다. 대기 제보는 4시간 뒤 삭제됩니다.',
    ...pageInfo(page, rows.length > PAGE_SIZE),
    reports: reports.map((r) => ({
      arcade: r.arcadeName,
      machine: r.machineName,
      cabinet: r.cabinetNo ? `${r.cabinetNo}호기` : undefined,
      kind: r.kind,
      waitCount: r.waitCount ?? undefined,
      condition: r.condition ?? undefined,
      // 사용자가 쓴 문장이 모델 프롬프트에 들어가는 자리입니다. 길이를 자르고
      // "누가 쓴 것" 임을 표시해, 메모 안의 지시문이 시스템 규칙처럼 읽히지 않게 합니다.
      comment: r.comment ? `[사용자 메모] ${clip(r.comment, 200)}` : undefined,
      by: r.nickname ?? '익명',
      at: r.createdAt,
    })),
  };
}

export interface PostSearchArgs {
  query?: string | null;
  machine?: string | null;
  page?: number | null;
}

/** 커뮤니티 게시판 (/community 와 같은 소스) */
export async function searchPosts(args: PostSearchArgs): Promise<unknown> {
  const machineIds = await resolveMachineIds(args.machine);
  const page = pageOf(args.page);
  const { posts, total, hasMore } = await listPosts({
    machineId: machineIds[0] ?? null,
    q: args.query ?? null,
    sort: 'recent',
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return {
    ...pageInfo(page, hasMore, total),
    posts: posts.map((p) => ({
      title: p.title,
      // 게임 없는 공지는 '공지' 로 — null 을 그대로 주면 답변에 "게임: null" 이 샌다
      game: p.machineShortName ?? '공지',
      category: p.categoryLabel,
      excerpt: clip(p.excerpt),
      by: p.nickname,
      likes: p.likeCount,
      comments: p.commentCount,
      at: p.createdAt,
    })),
  };
}
