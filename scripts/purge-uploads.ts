/**
 * 첨부 청소 — 아무 글에도 붙지 않은 첨부와, 어떤 행도 가리키지 않는 파일을 지웁니다.
 *
 *   npm run uploads:purge            무엇을 지울지 미리보기 (지우지 않음)
 *   npm run uploads:purge -- --write 지우기
 *
 * 두 가지를 치웁니다 (lib/upload-housekeeping.ts):
 *   1. 글에 붙지 않은 채 24시간이 지난 첨부 행 — 쓰다 만 글. 업로드 라우트도 덤으로 20개씩 치우지만,
 *      한동안 아무도 안 올리면 쌓이므로 여기서 한 번에 비웁니다.
 *   2. 행이 없는 파일 — 글을 지우면 행은 CASCADE 로 사라지고 파일만 남습니다. 1시간보다 새 파일은
 *      (방금 저장돼 행을 만드는 중일 수 있어) 건너뜁니다.
 *
 * 서버에서는 앱 폴더에서 arcade 사용자로: sudo -u arcade -H bash -c "cd /opt/arcade-finder && npm run uploads:purge -- --write"
 */

import { getPrismaClient } from '../lib/prisma.ts';
import { describeTarget, loadScriptEnv } from '../lib/script-env.ts';
import { ORPHAN_AFTER_MS, purgeOrphanAttachments, sweepUnreferencedFiles } from '../lib/upload-housekeeping.ts';

loadScriptEnv();
const write = process.argv.includes('--write');
console.log(`대상 DB: ${describeTarget()} · ${write ? '지웁니다' : '미리보기 (지우려면 --write)'}`);

const prisma = await getPrismaClient();
const orphanCount = await prisma.post_images.count({
  where: { post_id: null, created_at: { lt: new Date(Date.now() - ORPHAN_AFTER_MS) } },
});
console.log(`1. 글에 붙지 않은 지 24시간이 넘은 첨부: ${orphanCount}개`);
if (write && orphanCount > 0) {
  let rows = 0;
  let files = 0;
  for (;;) {
    const r = await purgeOrphanAttachments({ limit: 200 });
    rows += r.rows;
    files += r.files;
    if (r.rows === 0) break;
  }
  console.log(`   → 행 ${rows}개 · 파일 ${files}개 지움 (다른 행이 같이 쓰는 파일은 남김)`);
}

const sweep = await sweepUnreferencedFiles({ dryRun: !write });
console.log(`2. 행이 없는 파일: ${sweep.removed.length}개 (저장소 전체 ${sweep.scanned}개)`);
for (const key of sweep.removed.slice(0, 20)) console.log(`   ${write ? '지움' : '대상'} ${key}`);
if (sweep.removed.length > 20) console.log(`   … 외 ${sweep.removed.length - 20}개`);

await prisma.$disconnect();
