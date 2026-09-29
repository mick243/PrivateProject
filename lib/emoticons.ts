import {
  EMOTICON_ADMIN_PAGE_SIZE,
  EMOTICON_ADMIN_PAGE_SIZE_MAX,
  EMOTICON_NAME_MAX,
  type Emoticon,
  type EmoticonAdminRow,
  type EmoticonStatus,
} from './community-types';
import type { Prisma } from './generated/prisma/client.ts';
import { isUniqueViolation } from './pg-errors';
import { getPrismaClient, iso } from './prisma';

/**
 * 그림 이모티콘 (db/migrate-062-emoticons.sql · 064 soft delete).
 *
 * 등록은 관리자만, 쓰는 것은 누구나입니다. 파일 자체는 글 첨부와 같은 저장소를
 * 쓰지만(lib/uploads.ts save) post_images 행으로 만들지 않습니다 — 그 표의
 * post_id 가 NULL 인 행은 언젠가 청소 대상이고, 이모티콘이 거기 섞이면 청소가
 * 이모티콘을 지웁니다.
 *
 * ─── soft delete ─────────────────────────────────────────
 * "지우기" 는 `deleted_at` 을 찍는 것입니다(PetMediSearch-rebuild 의 방식). 읽는
 * 쿼리는 전부 `deleted_at IS NULL` 을 붙이고, 관리 페이지만 지운 것도 봅니다.
 * 되살리면 같은 id 가 돌아오므로 그 사이 이름표로 보이던 옛 댓글의 [[emo:N]] 도
 * 다시 그림이 됩니다.
 */

const url = (id: number): string => `/api/emoticons/${id}/image`;

export class EmoticonNameTakenError extends Error {
  constructor() {
    super('같은 이름의 이모티콘이 이미 있습니다');
  }
}

/** 이름은 화면에 그대로 뜨는 값이라 서버에서도 다듬습니다 */
export function normalizeName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, EMOTICON_NAME_MAX);
}

/**
 * 이름 UNIQUE(살아 있는 것 사이 · emoticons_name_key) 위반만 사용자 입력 문제로 되돌립니다.
 *
 * 이 표에 UNIQUE 는 PK 말고 그것 하나라, 어느 제약인지 이름을 맞춰 보지 않고
 * "UNIQUE 위반이면 이름" 으로 봅니다. 부분 인덱스(lower(name) WHERE deleted_at IS NULL)는
 * Prisma 스키마에 없어서 제약 이름이 에러에 실리지 않을 수 있기 때문입니다.
 */
function rethrowNameTaken(err: unknown): never {
  if (isUniqueViolation(err)) throw new EmoticonNameTakenError();
  throw err;
}

/**
 * 고르는 칸에 뿌릴 전체 목록 — 살아 있는 것만.
 *
 * 페이지를 나누지 않습니다 — 관리자가 손으로 올리는 것이라 수백 개가 되는 물건이
 * 아니고, 고르는 칸은 전부 한 번에 보여야 쓸모가 있습니다. 수백 개가 되면 그때
 * 분류를 먼저 붙여야지 페이지를 나눌 일이 아닙니다.
 */
export async function listEmoticons(): Promise<Emoticon[]> {
  const prisma = await getPrismaClient();
  const rows = await prisma.emoticons.findMany({
    where: { deleted_at: null },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    select: { id: true, name: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, url: url(r.id) }));
}

/**
 * 그림을 내보낼 때 필요한 것만.
 *
 * 지운 것도 돌려줍니다 — 관리 페이지의 "지운 것" 탭이 미리보기를 그려야 하고,
 * 그림 파일은 누구에게도 비밀이 아닙니다(목록에 뜨던 것). 고르는 칸에 뜨는지는
 * listEmoticons 가 정합니다.
 */
export async function getEmoticonFile(
  id: number,
): Promise<{ storageKey: string; mime: string } | null> {
  const prisma = await getPrismaClient();
  const row = await prisma.emoticons.findUnique({
    where: { id },
    select: { storage_key: true, mime: true },
  });
  return row ? { storageKey: row.storage_key, mime: row.mime } : null;
}

/**
 * 여러 이모티콘의 이름·파일을 한 번에. **지운 것도 돌려줍니다** — 리뷰 요약이
 * 옛 리뷰에 박힌 이모티콘을 그림으로 보려면 목록에서 뺀 것도 읽어야 합니다.
 * 고르는 칸에 뜨는지는 여기 일이 아닙니다(listEmoticons).
 */
export async function getEmoticonsByIds(
  ids: number[],
): Promise<Map<number, { name: string; storageKey: string; mime: string }>> {
  const out = new Map<number, { name: string; storageKey: string; mime: string }>();
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  if (unique.length === 0) return out;
  const prisma = await getPrismaClient();
  const rows = await prisma.emoticons.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, storage_key: true, mime: true },
  });
  for (const r of rows) out.set(r.id, { name: r.name, storageKey: r.storage_key, mime: r.mime });
  return out;
}

export async function createEmoticon(input: {
  name: string;
  storageKey: string;
  mime: string;
  bytes: number;
  playerId: number;
}): Promise<Emoticon> {
  const prisma = await getPrismaClient();
  try {
    const row = await prisma.emoticons.create({
      data: {
        name: input.name,
        storage_key: input.storageKey,
        mime: input.mime,
        bytes: input.bytes,
        created_by: input.playerId,
      },
      select: { id: true },
    });
    return { id: row.id, name: input.name, url: url(row.id) };
  } catch (err) {
    rethrowNameTaken(err);
  }
}

/**
 * 목록에서 뺍니다 — `deleted_at` 만 찍습니다. **행도 파일도 지우지 않습니다.**
 *
 * 파일은 내용 해시가 파일명이라 같은 그림을 쓰는 다른 이모티콘·첨부가 같은 파일을
 * 가리킬 수 있고, 행은 되살리기(restoreEmoticon)를 위해 남습니다.
 *
 * 이미 쓰인 댓글의 `[[emo:N]]` 은 남습니다. 그 자리는 화면이 이름표로 바꿔
 * 그립니다(components/EmoticonText.tsx) — 지운 이모티콘 때문에 남의 댓글이
 * 통째로 깨지지는 않게 합니다.
 *
 * 이미 지운 것을 다시 지우면 false — 두 번 눌러도 시각이 뒤로 밀리지 않습니다.
 */
export async function deleteEmoticon(id: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  const { count } = await prisma.emoticons.updateMany({
    where: { id, deleted_at: null },
    data: { deleted_at: new Date() },
  });
  return count > 0;
}

/**
 * 되살립니다. 그 사이 같은 이름으로 새 이모티콘이 올라왔으면 UNIQUE 에 걸립니다 —
 * 그때는 EmoticonNameTakenError. 관리자가 한쪽 이름을 바꾼 뒤 다시 누르면 됩니다.
 */
export async function restoreEmoticon(id: number): Promise<boolean> {
  const prisma = await getPrismaClient();
  try {
    const { count } = await prisma.emoticons.updateMany({
      where: { id, deleted_at: { not: null } },
      data: { deleted_at: null },
    });
    return count > 0;
  } catch (err) {
    rethrowNameTaken(err);
  }
}

/**
 * 이름을 바꿉니다. 본문은 id 로 가리키므로(062 머리말) 옛 댓글은 그대로 그림입니다 —
 * 바뀌는 건 고르는 칸의 이름표와 alt 텍스트만입니다. 살아 있는 것만 바꿉니다.
 */
export async function renameEmoticon(id: number, name: string): Promise<boolean> {
  const prisma = await getPrismaClient();
  try {
    const { count } = await prisma.emoticons.updateMany({
      where: { id, deleted_at: null },
      data: { name },
    });
    return count > 0;
  } catch (err) {
    rethrowNameTaken(err);
  }
}

// ─── 관리 페이지 ───────────────────────────────────────────

export interface EmoticonAdminQuery {
  /** 1-based */
  page: number;
  pageSize: number;
  status: EmoticonStatus;
  /** 이름 부분 일치 (대소문자 무시). 빈 문자열이면 전체 */
  q: string;
}

/** 쿼리스트링에서 온 값을 다듬습니다. 잘못된 값은 400 이 아니라 기본값 — 목록 화면은 늘 떠야 합니다 */
export function normalizeAdminQuery(input: {
  page?: unknown;
  pageSize?: unknown;
  status?: unknown;
  q?: unknown;
}): EmoticonAdminQuery {
  const page = Number(input.page);
  const pageSize = Number(input.pageSize);
  const status = String(input.status ?? '');
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize:
      Number.isInteger(pageSize) && pageSize > 0
        ? Math.min(pageSize, EMOTICON_ADMIN_PAGE_SIZE_MAX)
        : EMOTICON_ADMIN_PAGE_SIZE,
    status: status === 'deleted' || status === 'all' ? status : 'live',
    q: normalizeName(input.q),
  };
}

/**
 * 관리 목록 — 한 페이지와 전체 개수.
 *
 * WHERE 조건을 한 번 만들어 목록과 COUNT 가 **같은 조건**을 봅니다(PetMediSearch-rebuild
 * category.js 의 방식). 두 쿼리를 따로 짜면 필터를 하나 고칠 때 한쪽만 고쳐져
 * "24개 중 1~24" 가 실제 줄 수와 어긋납니다.
 *
 * 정렬은 created_at 에 id 를 덧붙입니다 — 같은 초에 올린 두 장이 페이지 경계에서
 * 순서가 뒤바뀌어 한 장이 두 번 보이거나 빠지지 않게.
 */
export async function listEmoticonsForAdmin(
  query: EmoticonAdminQuery,
): Promise<{ rows: EmoticonAdminRow[]; total: number }> {
  const prisma = await getPrismaClient();

  const where: Prisma.emoticonsWhereInput = {
    ...(query.status === 'live' ? { deleted_at: null } : {}),
    ...(query.status === 'deleted' ? { deleted_at: { not: null } } : {}),
    // Prisma 가 %·_ 를 이스케이프하므로 여기서 따로 하지 않습니다.
    ...(query.q !== '' ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.emoticons.count({ where }),
    prisma.emoticons.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        name: true,
        mime: true,
        bytes: true,
        created_at: true,
        deleted_at: true,
        players: { select: { nickname: true } },
      },
    }),
  ]);

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: url(r.id),
      mime: r.mime,
      bytes: r.bytes,
      createdBy: r.players?.nickname ?? null,
      createdAt: iso(r.created_at),
      deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
    })),
  };
}
