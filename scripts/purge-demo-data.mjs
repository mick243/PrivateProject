/**
 * 시드(예시) 데이터를 지웁니다 — **운영에 올리기 전에 한 번.**
 *
 *   npm run db:purge-demo              무엇을 지울지만 출력 (기본 · 아무것도 안 바꿈)
 *   npm run db:purge-demo -- --apply   실제로 지웁니다
 *
 * ─── 왜 필요한가 ───
 * `db/seed*.sql` 은 빈 DB 에서도 화면이 채워져 보이도록 예시를 넣습니다. 개발에는
 * 필요하지만 그대로 열면 사용자가 이런 것을 봅니다 (2026-09-13 UX 점검):
 *
 *   · 게시판 맨 위의 "테스트" 글 — 본문이 "이미지 첨부 테스트 영상 첨부 테스트"
 *   · "이번 달 지역 대회 정보 (가상)" — 본문에 "시드 데이터라서 실제 대회는 아닙니다"
 *   · 지도의 "강남 리듬스테이션 (가상)" 등 실재하지 않는 오락실 5곳
 *   · 그 오락실을 언급하는 글("강남 리듬스테이션 발판 점검했다고 합니다")
 *
 * ─── 무엇을 지우나 ───
 * 1. `arcades.source = 'seed'` 인 오락실(= 이름에 '(가상)' 이 붙은 곳, migrate-009)과
 *    거기 달린 기종·기체·제보·리뷰·즐겨찾기
 * 2. **제목이 시드 SQL 파일에 그대로 들어 있는 글**과 그 글의 댓글·추천·첨부
 * 3. 시드가 만든 플레이어 중 **아무것도 남기지 않은** 계정 (비밀번호·소셜 연결이 없고
 *    글·댓글·리뷰·제보·투표가 하나도 없는 행)
 *
 * 2번을 '테스트' 같은 낱말로 찾지 않고 **시드 파일과 대조**하는 이유: 시드 글은
 * "EXH 17에서 벽 느끼는 중" 처럼 진짜 사람이 쓴 것과 구분되지 않게 쓰여 있습니다.
 * 낱말로 고르면 진짜 글을 지우거나 시드 글을 남깁니다. 파일에 있는 제목과 똑같은
 * 글만 고르면 둘 다 일어나지 않습니다 — 판단이 아니라 대조입니다.
 *
 * 실제 사용자가 쓴 것은 이 조건에 걸리지 않습니다. 그래도 지우는 작업이므로
 * `--apply` 전에 `pg_dump -Fc` 로 떠 두세요 (deploy/backup.sh).
 *
 * 서열표의 곡·채보(펌프 4,466 · 사볼 691)는 **시드가 아니라 실데이터**라 건드리지
 * 않습니다. 기종 마스터(machines)도 그대로 둡니다.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');

const envFile = path.join(root, '.env.local');
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*DATABASE_URL\s*=\s*(.*)\s*$/.exec(line);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 이 없습니다.');
  process.exit(2);
}

/** 시드 SQL 원문 — 여기에 제목이 그대로 있으면 그 글은 시드가 만든 것이다 */
const seedText = ['seed-board.sql', 'seed-community.sql', 'seed.sql', 'seed-tier.sql']
  .map((f) => {
    const file = path.join(root, 'db', f);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  })
  .join('\n');

/** 제목이 시드 파일에 작은따옴표째 등장하는가 (따옴표가 든 제목은 걸리지 않는다 — 안전한 쪽) */
function isSeedTitle(title) {
  return title.length >= 4 && seedText.includes(`'${title}'`);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const q = async (sql, params) => (await client.query(sql, params)).rows;

  const arcades = await q(`SELECT id, name FROM arcades WHERE source = 'seed' ORDER BY id`);
  const allPosts = await q(`SELECT id, title FROM posts ORDER BY id`);
  const posts = allPosts.filter((p) => isSeedTitle(p.title));
  const orphanPlayers = await q(`
    SELECT pl.id, pl.nickname
      FROM players pl
     WHERE pl.password_hash IS NULL
       AND NOT pl.is_admin
       AND NOT EXISTS (SELECT 1 FROM player_identities i WHERE i.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM posts x WHERE x.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM post_comments x WHERE x.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM arcade_reviews x WHERE x.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM machine_reports x WHERE x.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM difficulty_votes x WHERE x.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM clear_records x WHERE x.player_id = pl.id)
       AND NOT EXISTS (SELECT 1 FROM chart_comments x WHERE x.player_id = pl.id)
     ORDER BY pl.id`);

  console.log(`대상: ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}\n`);
  console.log(`오락실(source='seed') ${arcades.length}곳`);
  for (const a of arcades) console.log(`   · #${a.id} ${a.name}`);
  console.log(`\n게시글 ${posts.length}개 / 전체 ${allPosts.length}개 (제목이 시드 파일에 있는 것)`);
  for (const p of posts) console.log(`   · #${p.id} ${p.title}`);
  const kept = allPosts.filter((p) => !isSeedTitle(p.title));
  if (kept.length) {
    console.log(`\n남는 글 ${kept.length}개`);
    for (const p of kept) console.log(`   · #${p.id} ${p.title}`);
  }
  console.log(`\n아무것도 남기지 않은 시드 계정 ${orphanPlayers.length}명`);
  console.log(`   ${orphanPlayers.map((p) => p.nickname).join(', ') || '(없음)'}`);

  if (!apply) {
    console.log('\n(--apply 를 붙이면 실제로 지웁니다. 먼저 pg_dump -Fc 로 백업하세요.)');
  } else {
    await client.query('BEGIN');
    try {
      // 글: 댓글·추천·첨부는 FK CASCADE 로 함께 지워진다 (db/schema-board.sql)
      const delPosts = posts.length
        ? await q(`DELETE FROM posts WHERE id = ANY($1::int[]) RETURNING id`, [posts.map((p) => p.id)])
        : [];
      // 오락실: 기종·기체·제보·리뷰·즐겨찾기도 CASCADE / SET NULL 로 정리된다
      const delArcades = await q(`DELETE FROM arcades WHERE source = 'seed' RETURNING id`);
      // 계정은 위에서 고른 id 만 (그 사이에 글을 썼다면 조건이 바뀌므로 다시 확인)
      const ids = orphanPlayers.map((p) => p.id);
      const delPlayers = ids.length
        ? await q(
            `DELETE FROM players pl
              WHERE pl.id = ANY($1::int[])
                AND NOT EXISTS (SELECT 1 FROM posts x WHERE x.player_id = pl.id)
                AND NOT EXISTS (SELECT 1 FROM post_comments x WHERE x.player_id = pl.id)
              RETURNING id`,
            [ids],
          )
        : [];
      await client.query('COMMIT');
      console.log(`\n✔ 글 ${delPosts.length} · 오락실 ${delArcades.length} · 계정 ${delPlayers.length} 삭제`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ 롤백했습니다 — ${err.message}`);
      process.exitCode = 1;
    }
  }
} finally {
  await client.end();
}
