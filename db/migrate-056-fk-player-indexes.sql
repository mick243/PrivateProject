-- ============================================================
-- 056 · 사용자에게 달린 행을 찾는 인덱스
--
-- `players.id` 를 참조하는 표가 여럿인데 그중 인덱스가 있는 것은 둘뿐이었습니다
-- (2026-09-13 QA). 부모 행을 지울 때 PostgreSQL 은 자식 표를 **전부 훑어** 참조를
-- 확인하므로, 인덱스가 없으면 표마다 순차 스캔이 한 번씩 일어납니다.
--
-- 그 경로가 이제 실제로 열려 있습니다 — 회원 탈퇴(DELETE /api/account)가 들어갔고,
-- 그 한 번의 요청이 글·댓글·추천·리뷰·제보·투표·클리어·평가·즐겨찾기·첨부를
-- 모두 건드립니다. 목표 규모(글 2만·제보 2.5만)에서 수십 ms 수준이지만, 인덱스
-- 하나로 사라지는 비용이라 미룰 이유가 없습니다.
--
-- "내가 쓴 글 보기" 같은 화면을 나중에 붙일 때도 같은 인덱스를 씁니다.
--
-- ⚠ CONCURRENTLY 를 쓰지 않습니다 — 마이그레이션 러너가 BEGIN/COMMIT 으로 감싸는데
--   CONCURRENTLY 는 트랜잭션 안에서 실행할 수 없습니다 (lib/db.ts runMigrations).
--   지금 표 크기(수만 행)에서는 잠금 시간이 짧아 문제가 되지 않습니다. 수백만 행이
--   된 뒤에 인덱스를 더할 일이 생기면 그때는 psql 로 따로 돌리세요.
-- ============================================================

CREATE INDEX IF NOT EXISTS posts_player_idx           ON posts (player_id);
CREATE INDEX IF NOT EXISTS post_comments_player_idx   ON post_comments (player_id);
CREATE INDEX IF NOT EXISTS post_images_player_idx     ON post_images (player_id);
CREATE INDEX IF NOT EXISTS arcade_reviews_player_idx  ON arcade_reviews (player_id);
CREATE INDEX IF NOT EXISTS chart_comments_player_idx  ON chart_comments (player_id);

-- 제보는 ON DELETE SET NULL 이라 지우지 않고 **비웁니다**(익명화). 그래도 그 UPDATE
-- 가 같은 스캔을 하므로 인덱스가 필요합니다. NULL 은 찾을 일이 없어 부분 인덱스로.
CREATE INDEX IF NOT EXISTS machine_reports_player_idx
  ON machine_reports (player_id) WHERE player_id IS NOT NULL;
