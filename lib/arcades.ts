import { cacheReference } from './cache';
import { arcadeSearchPage, arcadesWithMachines } from './typed-sql';
import { getPrismaClient, num, TX_OPTIONS, type PrismaTx } from './prisma';
import type { Arcade, ArcadeInput, ArcadeMachine, Machine, MachineGuess } from './types';

/**
 * 오락실.
 *
 * 목록·단건 조회는 **TypedSQL** 입니다 (prisma/sql/arcadesWithMachines.sql). haversine
 * 반경 계산 · 낱말 분해 검색 · 기종 AND 필터 · 두 뷰를 조인한 json_agg 는 Prisma Client
 * API 로 표현되지 않고, 그 SQL 에는 측정으로 고른 모양이 있습니다 — 아래 주석이 그
 * 근거입니다. 쓰기(등록·수정·삭제·기종 교체)는 Prisma Client 입니다.
 *
 * ─── 왜 상관 서브쿼리를 버렸나 ───────────────────────────────
 * 예전에는 `MACHINES_SUBQUERY` 라는 상관 서브쿼리 하나였고, 그게 **오락실마다
 * 한 번씩** 돌았습니다. 안에서 `machine_live` · `cabinet_condition` 두 뷰를
 * 건드리는데, 그 뷰들은 `machine_reports` **전체**를 집계합니다. 결과적으로
 * 전체 집계가 939번 재평가됐습니다.
 *
 * 목표 규모 데이터로 재면 이렇습니다 (오락실 939 · 기체 5,644 · 제보 25,619).
 *
 *   기존(상관 서브쿼리)  실행 36.0ms · 버퍼 44,042
 *   지금(CTE 집계)       실행 20.0ms · **버퍼 163**   ← 270분의 1
 *
 * ─── 왜 하나로 두고 필터를 받나 ─────────────────────────────
 * 목록(listArcades)과 단일 조회(getArcade)가 같은 SQL 을 씁니다. **정의를 둘로
 * 나누지 않는 이유**는 이 프로젝트가 이미 겪은 함정입니다 — 같은 규칙을 두 곳에
 * 적으면 한쪽만 고쳐지고, 그러면 목록과 상세가 다른 오락실을 보여 줍니다.
 *
 * ─── 좁히지 않으면 필터 검색이 느려집니다 ───────────────────
 * 집계를 한 번만 하는 것이 **결과가 많을 때** 이깁니다. 반경 검색처럼 30곳만
 * 남는 경우에 전체(기체 5,644)를 집계하면 오히려 손해라(처음 CTE 를 넣었을 때 반경
 * 검색이 8ms → 26ms 로 3배 느려졌습니다), 집계는 **바깥에서 고른 오락실만** 합니다.
 *
 * ─── 두 뷰가 서로 다른 단위로 붙습니다 ─────────────────────
 *   machine_live       대기   → (오락실, 기종)  줄은 게임 앞에 선다
 *   cabinet_condition  컨디션 → 기체 1대        1호기는 멀쩡한데 2호기만 죽어 있을 수 있다
 * machine_live 는 수명 안의 제보만 담고 LEFT JOIN 이라, 유효한 제보가 없으면 live 가
 * null 로 나가고 UI 는 "지금 대기" 칸을 아예 그리지 않습니다. 만료된 값을 0 으로 바꿔
 * 내보내면 "대기 없음" 이라는 없는 정보가 생깁니다.
 */

type ArcadeRow = Awaited<ReturnType<typeof fetchArcades>>[number];

async function fetchArcades(params: {
  lat?: number | null;
  lng?: number | null;
  tokens?: string[] | null;
  machineIds?: number[] | null;
  radiusKm?: number | null;
  arcadeId?: number | null;
  /** 이 id 들만 — 쪽 하나를 집계할 때(pageArcades). 비어 있으면 필터 없음 */
  ids?: number[] | null;
}) {
  const prisma = await getPrismaClient();
  return prisma.$queryRawTyped(
    arcadesWithMachines(
      params.lat ?? null,
      params.lng ?? null,
      params.tokens ?? [],
      params.machineIds ?? [],
      params.radiusKm ?? null,
      params.arcadeId ?? null,
      params.ids ?? [],
    ),
  );
}

function toArcade(row: ArcadeRow): Arcade {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    openTime: row.open_time,
    closeTime: row.close_time,
    is24h: row.is_24h,
    phone: row.phone,
    note: row.note,
    homepage: row.homepage ?? null,
    // json_agg 는 파싱된 값으로 옵니다. 모양은 SQL 이 만든 그대로입니다.
    machines: (row.machines ?? []) as unknown as ArcadeMachine[],
    distanceKm: row.distance_km,
    // NUMERIC 은 Decimal 로 옵니다.
    ratingAvg: num(row.rating_avg),
    reviewCount: row.review_count,
  };
}

export interface ListArcadesParams {
  /** 이름/주소 부분 일치 */
  q?: string | null;
  /** 선택한 기종을 "모두" 보유한 오락실만 (AND 조건) */
  machineIds?: number[] | null;
  /** 반경 검색 기준 좌표 */
  lat?: number | null;
  lng?: number | null;
  /** 반경(km). lat/lng 와 함께일 때만 적용 */
  radiusKm?: number | null;
}

/**
 * 검색어를 낱말로 쪼갭니다 — "홍대 짱" 이 "짱오락실 홍대점" 을 찾게 하기 위해.
 *
 * 통짜 부분 일치('%홍대 짱%')는 어순과 붙임새가 정확히 같아야만 걸립니다.
 * 사람은 지점을 "동네 + 이름 아무 조각" 으로 기억하므로, 낱말마다 따로
 * 이름·주소에 걸리면 매치로 봅니다 (SQL 쪽에서 AND 로 묶습니다).
 *
 * 8개 상한: 낱말 하나가 ILIKE 두 번이라, 상한이 없으면 공백 잔뜩인 입력이
 * 스캔 비용을 마음대로 키웁니다.
 */
export function searchTokens(q: string | null | undefined): string[] | null {
  if (!q) return null;
  const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return tokens.length ? tokens : null;
}

function filtersOf(params: ListArcadesParams) {
  const { q = null, machineIds = null, lat = null, lng = null, radiusKm = null } = params;
  return {
    lat,
    lng,
    tokens: searchTokens(q),
    // 같은 id 가 두 번 와도(?machines=1,1) SQL 이 중복을 빼고 셉니다.
    machineIds: machineIds && machineIds.length ? machineIds : null,
    radiusKm,
  };
}

/** 조건에 맞는 오락실 전부 — 지도 목록(/api/arcades)이 씁니다 */
export async function listArcades(params: ListArcadesParams): Promise<Arcade[]> {
  const rows = await fetchArcades(filtersOf(params));
  return rows.map(toArcade);
}

export interface ArcadePage {
  arcades: Arcade[];
  /** 자르기 전 조건에 맞는 수. 범위 밖 쪽을 달라고 해 행이 없으면 null (그때는 셀 행이 없습니다) */
  total: number | null;
}

/**
 * 조건에 맞는 오락실의 **한 쪽** — 챗봇 도구(lib/chat-tools.ts)가 씁니다.
 *
 * listArcades 로 전부 받아 앞의 몇 개만 쓰면, 버릴 오락실의 기종·기체·컨디션까지 집계합니다
 * (목표 규모에서 기종 하나로 찾으면 926곳 — 2026-09-28 실측 28.5ms). 그래서 두 번에 나눕니다:
 *   1. prisma/sql/arcadeSearchPage.sql — 같은 조건으로 그 쪽의 id 와 전체 수만 (집계 없음)
 *   2. arcadesWithMachines.sql — 그 id 들만 집계
 * 두 SQL 의 조건 블록은 글자까지 같습니다(tests/typed-sql.test.ts). 순서도 listArcades 와 같습니다
 * (거리 → 이름 → id). 쪽 나누기를 한 SQL 안에 넣는 방법은 지도 목록을 느리게 해 버렸습니다 —
 * 그 SQL 머리말.
 */
export async function pageArcades(
  params: ListArcadesParams,
  page: { limit: number; offset: number },
): Promise<ArcadePage> {
  const f = filtersOf(params);
  const prisma = await getPrismaClient();
  const picked = await prisma.$queryRawTyped(
    arcadeSearchPage(f.lat, f.lng, f.tokens ?? [], f.machineIds ?? [], f.radiusKm, null, [], page.limit, page.offset),
  );
  const total = picked[0]?.total_count ?? (page.offset === 0 ? 0 : null);
  if (picked.length === 0) return { arcades: [], total };
  const rows = await fetchArcades({ lat: f.lat, lng: f.lng, ids: picked.map((p) => p.id) });
  return { arcades: rows.map(toArcade), total };
}

export async function getArcade(id: number): Promise<Arcade | null> {
  const [row] = await fetchArcades({ arcadeId: id });
  return row ? toArcade(row) : null;
}

/**
 * 보유 기종·기체를 입력값에 맞춘다 (제보 반영은 이 경로 하나로 통일).
 *
 * 통째로 지우고 다시 넣지 않는 이유: 컨디션 제보가 arcade_cabinets.id 를
 * 가리킨다. DELETE + INSERT 로 새 id 를 받으면 오락실 정보를 한 글자만 고쳐도
 * 그 오락실의 컨디션 제보가 전부 주인을 잃는다. 그래서 남을 것은 남기고
 * (cabinet_no 로 맞춰 UPDATE), 빠진 것만 지운다.
 */
async function replaceMachines(
  tx: PrismaTx,
  arcadeId: number,
  machines: ArcadeInput['machines'],
): Promise<void> {
  const machineIds = machines.map((m) => m.machineId);

  // 입력에서 빠진 기종은 제거 — 그 기체들도 FK CASCADE 로 함께 사라진다.
  await tx.arcade_machines.deleteMany({
    where: {
      arcade_id: arcadeId,
      ...(machineIds.length ? { machine_id: { notIn: machineIds } } : {}),
    },
  });

  for (const m of machines) {
    await tx.arcade_machines.upsert({
      where: { arcade_id_machine_id: { arcade_id: arcadeId, machine_id: m.machineId } },
      create: { arcade_id: arcadeId, machine_id: m.machineId },
      update: { updated_at: new Date() },
    });

    // 기체가 0대인 기종은 화면에서 통째로 사라지므로 최소 1대는 남긴다.
    const count = Math.max(1, m.cabinets.length);

    // 대수를 줄이면 뒤 번호부터 없어진다 (1호기가 남고 3호기가 빠진다).
    await tx.arcade_cabinets.deleteMany({
      where: { arcade_id: arcadeId, machine_id: m.machineId, cabinet_no: { gt: count } },
    });

    for (let i = 0; i < count; i += 1) {
      const condition = m.cabinets[i]?.condition ?? null;
      await tx.arcade_cabinets.upsert({
        where: {
          arcade_id_machine_id_cabinet_no: {
            arcade_id: arcadeId,
            machine_id: m.machineId,
            cabinet_no: i + 1,
          },
        },
        create: { arcade_id: arcadeId, machine_id: m.machineId, cabinet_no: i + 1, condition },
        update: { condition, updated_at: new Date() },
      });
    }
  }
}

export async function createArcade(input: ArcadeInput): Promise<Arcade> {
  const prisma = await getPrismaClient();
  const id = await prisma.$transaction(async (tx) => {
    const created = await tx.arcades.create({
      data: {
        name: input.name,
        address: input.address,
        lat: input.lat,
        lng: input.lng,
        open_time: input.openTime,
        close_time: input.closeTime,
        is_24h: input.is24h,
        phone: input.phone,
        note: input.note,
      },
      select: { id: true },
    });
    await replaceMachines(tx, created.id, input.machines);
    return created.id;
  }, TX_OPTIONS);

  const arcade = await getArcade(id);
  if (!arcade) throw new Error(`방금 만든 오락실 ${id} 을 다시 읽지 못했습니다`);
  return arcade;
}

export async function updateArcade(
  id: number,
  input: ArcadeInput,
): Promise<Arcade | null> {
  const prisma = await getPrismaClient();
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.arcades.updateMany({
      where: { id },
      data: {
        name: input.name,
        address: input.address,
        lat: input.lat,
        lng: input.lng,
        open_time: input.openTime,
        close_time: input.closeTime,
        is_24h: input.is24h,
        phone: input.phone,
        note: input.note,
        updated_at: new Date(),
      },
    });
    if (count === 0) return false;
    await replaceMachines(tx, id, input.machines);
    return true;
  }, TX_OPTIONS);

  return updated ? await getArcade(id) : null;
}

export async function deleteArcade(id: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  // arcade_machines 는 ON DELETE CASCADE 로 함께 정리된다.
  const { count } = await prisma.arcades.deleteMany({ where: { id } });
  return count > 0;
}

async function listMachinesUncached(): Promise<Machine[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.machines.findMany({
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, short_name: true, category: true },
  });

  // 리듬게임 특화 서비스이므로 리듬 기종을 항상 앞에 둔다. 그 안의 순서는 sort_order —
  // id 는 참조 키라서 순서 조정에 쓸 수 없다. (정렬은 안정적이라 위 순서가 유지된다.)
  const rank = (category: string) => (category === 'rhythm' ? 0 : 1);
  return rows
    .sort((a, b) => rank(a.category) - rank(b.category))
    .map((r) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      category: r.category as Machine['category'],
    }));
}

/**
 * 기종 마스터 목록 (필터·등록 폼·챗봇이 공유한다).
 *
 * 앱에서 machines 를 쓰는 경로가 없어 캐시해 둔다 — 자세한 근거는 lib/cache.ts.
 */
export const listMachines = cacheReference(listMachinesUncached, 'machines');

// ─── 보유 기종 추정 (AI) ─────────────────────────────────────

/**
 * 이 오락실을 **한 번이라도 검색해 봤는지**. 거르기 전의 날것을 셉니다.
 *
 * listMachineGuesses 로는 이 판단을 할 수 없습니다 — 찾은 것이 전부 이미 확정된
 * 기종이면 빈 배열이 돌아오고, 그러면 "아직 안 해 봤다" 로 읽혀 같은 곳을
 * 몇 번이고 다시 검색하게 됩니다. 검색은 요청마다 돈이 나갑니다.
 */
export async function countMachineGuesses(arcadeId: number): Promise<number> {
  const prisma = await getPrismaClient();
  return prisma.arcade_machine_guesses.count({ where: { arcade_id: arcadeId } });
}

/**
 * 이 오락실의 **추정** 기종. 확정(arcade_machines)과 섞지 않습니다.
 *
 * 목록 쿼리에 얹지 않고 따로 두는 이유: 추정은 상세를 열었을 때만 필요한데,
 * 목록 쿼리는 939곳을 집계하는 성능 민감한 자리입니다(PERFORMANCE.md 4부).
 * 거기에 조인을 하나 더 얹으면 상세를 안 여는 대다수가 그 값을 치릅니다.
 *
 * 이미 확정된 기종은 빼고 돌려줍니다 — 사람이 확인한 것을 "추정" 으로 다시
 * 물으면 화면이 스스로를 의심하는 꼴이 됩니다.
 */
export async function listMachineGuesses(arcadeId: number): Promise<MachineGuess[]> {
  const prisma = await getPrismaClient();
  const [guesses, confirmed] = await Promise.all([
    prisma.arcade_machine_guesses.findMany({
      where: { arcade_id: arcadeId },
      orderBy: { machine_id: 'asc' },
      select: {
        machine_id: true,
        evidence: true,
        machines: { select: { name: true, short_name: true } },
      },
    }),
    prisma.arcade_machines.findMany({
      where: { arcade_id: arcadeId },
      select: { machine_id: true },
    }),
  ]);
  const confirmedIds = new Set(confirmed.map((c) => c.machine_id));
  return guesses
    .filter((g) => !confirmedIds.has(g.machine_id))
    .map((g) => ({
      machineId: g.machine_id,
      name: g.machines.name,
      shortName: g.machines.short_name ?? null,
      evidence: g.evidence,
    }));
}
