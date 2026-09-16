import { getDb } from './db';
import {
  EMOTICON_ADMIN_PAGE_SIZE,
  EMOTICON_ADMIN_PAGE_SIZE_MAX,
  EMOTICON_NAME_MAX,
  type Emoticon,
  type EmoticonAdminRow,
  type EmoticonStatus,
} from './community-types';

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

/** 이름 UNIQUE(살아 있는 것 사이) 위반만 사용자 입력 문제로 되돌립니다 */
function rethrowNameTaken(err: unknown): never {
  if (err instanceof Error && /emoticons_name_key/.test(err.message)) {
    throw new EmoticonNameTakenError();
  }
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
  const db = await getDb();
  const { rows } = await db.query<{ id: number | string; name: string }>(
    `SELECT id, name FROM emoticons
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC, id DESC`,
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, url: url(Number(r.id)) }));
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
  const db = await getDb();
  const { rows } = await db.query<{ storage_key: string; mime: string }>(
    `SELECT storage_key, mime FROM emoticons WHERE id = $1::int`,
    [id],
  );
  const row = rows[0];
  return row ? { storageKey: row.storage_key, mime: row.mime } : null;
}

export async function createEmoticon(input: {
  name: string;
  storageKey: string;
  mime: string;
  bytes: number;
  playerId: number;
}): Promise<Emoticon> {
  const db = await getDb();
  try {
    const { rows } = await db.query<{ id: number | string }>(
      `INSERT INTO emoticons (name, storage_key, mime, bytes, created_by)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.name, input.storageKey, input.mime, input.bytes, input.playerId],
    );
    const id = Number(rows[0].id);
    return { id, name: input.name, url: url(id) };
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
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `UPDATE emoticons SET deleted_at = now()
      WHERE id = $1::int AND deleted_at IS NULL
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * 되살립니다. 그 사이 같은 이름으로 새 이모티콘이 올라왔으면 UNIQUE 에 걸립니다 —
 * 그때는 EmoticonNameTakenError. 관리자가 한쪽 이름을 바꾼 뒤 다시 누르면 됩니다.
 */
export async function restoreEmoticon(id: number): Promise<boolean> {
  const db = await getDb();
  try {
    const { rows } = await db.query<{ id: number }>(
      `UPDATE emoticons SET deleted_at = NULL
        WHERE id = $1::int AND deleted_at IS NOT NULL
        RETURNING id`,
      [id],
    );
    return rows.length > 0;
  } catch (err) {
    rethrowNameTaken(err);
  }
}

/**
 * 이름을 바꿉니다. 본문은 id 로 가리키므로(062 머리말) 옛 댓글은 그대로 그림입니다 —
 * 바뀌는 건 고르는 칸의 이름표와 alt 텍스트만입니다. 살아 있는 것만 바꿉니다.
 */
export async function renameEmoticon(id: number, name: string): Promise<boolean> {
  const db = await getDb();
  try {
    const { rows } = await db.query<{ id: number }>(
      `UPDATE emoticons SET name = $2
        WHERE id = $1::int AND deleted_at IS NULL
        RETURNING id`,
      [id, name],
    );
    return rows.length > 0;
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

interface AdminRowRaw {
  id: number | string;
  name: string;
  mime: string;
  bytes: number | string;
  created_by: string | null;
  created_at: string | Date;
  deleted_at: string | Date | null;
}

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/**
 * 관리 목록 — 한 페이지와 전체 개수.
 *
 * WHERE 절과 값 배열을 한 번 만들어 목록 쿼리와 COUNT 쿼리가 **같은 조건**을
 * 봅니다(PetMediSearch-rebuild category.js 의 방식). 두 쿼리를 따로 짜면 필터를
 * 하나 고칠 때 한쪽만 고쳐져 "24개 중 1~24" 가 실제 줄 수와 어긋납니다.
 *
 * 정렬은 created_at 에 id 를 덧붙입니다 — 같은 초에 올린 두 장이 페이지 경계에서
 * 순서가 뒤바뀌어 한 장이 두 번 보이거나 빠지지 않게.
 */
export async function listEmoticonsForAdmin(
  query: EmoticonAdminQuery,
): Promise<{ rows: EmoticonAdminRow[]; total: number }> {
  const db = await getDb();

  const where: string[] = [];
  const values: unknown[] = [];
  if (query.status === 'live') where.push('e.deleted_at IS NULL');
  else if (query.status === 'deleted') where.push('e.deleted_at IS NOT NULL');
  if (query.q !== '') {
    values.push(`%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`e.name ILIKE $${values.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: countRows } = await db.query<{ total: number | string }>(
    `SELECT COUNT(*)::int AS total FROM emoticons e ${whereSql}`,
    values,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const offset = (query.page - 1) * query.pageSize;
  const { rows } = await db.query<AdminRowRaw>(
    `SELECT e.id, e.name, e.mime, e.bytes, p.nickname AS created_by, e.created_at, e.deleted_at
       FROM emoticons e
       LEFT JOIN players p ON p.id = e.created_by
       ${whereSql}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, query.pageSize, offset],
  );

  return {
    total,
    rows: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      url: url(Number(r.id)),
      mime: r.mime,
      bytes: Number(r.bytes),
      createdBy: r.created_by,
      createdAt: iso(r.created_at) ?? '',
      deletedAt: iso(r.deleted_at),
    })),
  };
}
