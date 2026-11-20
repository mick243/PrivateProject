/**
 * 첨부 청소 · 사람마다의 업로드 총량.
 *
 * ─── 왜 필요한가 (2026-11-20 문제점 조사) ──────────────────────────
 * 첨부는 글보다 먼저 올라갑니다(app/api/uploads). 글을 저장하지 않고 나가면 post_id 가 NULL 인
 * 행과 파일이 영영 남고, 글을 지우면 행은 FK CASCADE 로 사라지지만 **파일은 디스크에 남습니다.**
 * 서버 디스크가 10GB 라 쌓이면 백업까지 함께 막힙니다. 횟수 · 용량 상한도 없어서 한 계정이 하루에
 * 동영상 50MB 를 몇백 번 올릴 수 있었습니다.
 *
 * ⚠ 파일 이름이 내용 해시라 **한 파일을 여러 행이 같이 씁니다** (lib/uploads.ts save). 행을 지울 때는
 *   그 키를 가리키는 행이 더 없을 때만 파일을 지웁니다.
 *
 * 서버 전용입니다 (Prisma).
 */

import { getPrismaClient } from './prisma.ts';
import { listStored, remove } from './uploads.ts';

/** 글에 붙지 않은 첨부를 이만큼 지나면 버린 것으로 봅니다 — 긴 글을 쓰는 동안은 살려 둡니다 */
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * 글에 붙지 않은 채 ORPHAN_AFTER_MS 를 넘긴 첨부를 지웁니다 (행 + 아무도 안 쓰는 파일).
 *
 * `limit` 만큼만 — 업로드 요청 안에서 덤으로 부르므로 한 번에 오래 걸리면 안 됩니다
 * (post_images_orphan_idx 가 이 조회를 받습니다).
 */
export async function purgeOrphanAttachments(
  opts: { limit?: number; now?: Date } = {},
): Promise<{ rows: number; files: number }> {
  const prisma = await getPrismaClient();
  const before = new Date((opts.now ?? new Date()).getTime() - ORPHAN_AFTER_MS);
  const rows = await prisma.post_images.findMany({
    where: { post_id: null, created_at: { lt: before } },
    select: { id: true, storage_key: true },
    orderBy: { created_at: 'asc' },
    take: opts.limit ?? 20,
  });
  if (rows.length === 0) return { rows: 0, files: 0 };

  await prisma.post_images.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });

  const keys = [...new Set(rows.map((r) => r.storage_key))];
  const stillUsed = new Set(
    (
      await prisma.post_images.findMany({
        where: { storage_key: { in: keys } },
        select: { storage_key: true },
      })
    ).map((r) => r.storage_key),
  );
  let files = 0;
  for (const key of keys) {
    if (stillUsed.has(key)) continue;
    await remove(key);
    files++;
  }
  return { rows: rows.length, files };
}

/**
 * 어떤 행도 가리키지 않는 파일을 지웁니다 — 글 삭제(CASCADE)로 행만 사라진 파일.
 *
 * 디스크 전체를 훑으므로 요청 안에서 부르지 않고 scripts/purge-uploads.ts 로 돌립니다.
 * 방금 저장해 아직 행이 없는 파일을 지우지 않게 `graceMs` 보다 새 파일은 건너뜁니다.
 */
export async function sweepUnreferencedFiles(
  opts: { dryRun?: boolean; graceMs?: number; now?: number } = {},
): Promise<{ scanned: number; removed: string[] }> {
  const prisma = await getPrismaClient();
  const stored = await listStored();
  const referenced = new Set(
    (await prisma.post_images.findMany({ select: { storage_key: true }, distinct: ['storage_key'] })).map(
      (r) => r.storage_key,
    ),
  );
  const cutoff = (opts.now ?? Date.now()) - (opts.graceMs ?? 60 * 60 * 1000);
  const removed: string[] = [];
  for (const f of stored) {
    if (referenced.has(f.storageKey) || f.mtimeMs > cutoff) continue;
    if (!opts.dryRun) await remove(f.storageKey);
    removed.push(f.storageKey);
  }
  return { scanned: stored.length, removed };
}

/** 이 사람이 최근 24시간에 올린 바이트 수 (글에 붙었든 아니든) */
export async function bytesUploadedLastDay(playerId: number, now = new Date()): Promise<number> {
  const prisma = await getPrismaClient();
  const agg = await prisma.post_images.aggregate({
    where: { player_id: playerId, created_at: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    _sum: { bytes: true },
  });
  return agg._sum.bytes ?? 0;
}
