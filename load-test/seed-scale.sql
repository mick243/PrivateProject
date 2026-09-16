-- =====================================================================
-- 목표 규모 데이터 생성 — 가입자 10,000 · DAU 3,000 으로 1년 굴린 상태
-- =====================================================================
--
-- 왜 필요한가: 지금까지의 부하 기준선은 전부 **빈 크라우드소싱 계층** 위에서
-- 잰 것입니다. arcade_machines 가 4행이라 /api/arcades 의 상관 서브쿼리가
-- 939번 돌면서 전부 빈 결과를 냈고, machine_reports 가 0행이라 /live 의
-- 만료 DELETE 도 공짜였습니다. PERFORMANCE.md 1부가 직접 경고해 둔 대로
-- ("데이터를 채우면 이 기준선은 무효입니다") 채운 상태에서 다시 재야 합니다.
--
-- ⚠ 개발 DB 에 절대 돌리지 마세요. 아래 가드가 DB 이름이 '_scale' 로 끝나지
--   않으면 멈춥니다. 쓰는 법:
--
--     psql -w "$BASE/postgres" -c "CREATE DATABASE arcade_finder_scale"
--     pg_restore -w -d "$BASE/arcade_finder_scale" dev.dump
--     psql -w "$BASE/arcade_finder_scale" -f load-test/seed-scale.sql
--
-- 생성량의 근거는 load-test/capacity-model.mjs 와 같은 가정입니다.
--
-- ⚠ **실행마다 건수가 달라집니다.** `LIMIT 2 + (random()*4)::int` 같은 표현은
--   Postgres 가 쿼리당 한 번만 평가할 수도, 행마다 평가할 수도 있어서 배수가
--   흔들립니다(실측: arcade_machines 2,821~3,759 · post_comments 40,028~120,028).
--   자릿수는 맞으므로 부하 데이터로는 충분하지만, **두 번의 측정을 비교하려면
--   같은 DB 를 계속 쓰세요.** 새로 시드하고 비교하면 데이터 차이가 섞입니다.
-- =====================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() NOT LIKE '%\_scale' THEN
    RAISE EXCEPTION
      'Refusing to run: current database is %, expected a name ending in _scale',
      current_database();
  END IF;
END
$guard$;

-- 본문 길이를 한글 게시글에 맞춥니다. 한글은 UTF-8 에서 3바이트라 300자 =
-- 900바이트입니다. psql 인자 인코딩 사고를 피하려고 내용은 ASCII 로 두고
-- **바이트 길이만** 맞춥니다 — 페이로드 크기 측정이 목적이라 그걸로 충분합니다.
\set body_bytes 900

BEGIN;

-- ---------------------------------------------------------------------
-- 1. players 10,000
-- ---------------------------------------------------------------------
INSERT INTO players (nickname, password_hash, is_admin, created_at)
SELECT
  'loadtest_user_' || g,
  'scrypt$placeholder$' || md5(g::text),
  false,
  now() - (random() * interval '365 days')
FROM generate_series(1, 10000) g
WHERE NOT EXISTS (SELECT 1 FROM players WHERE nickname = 'loadtest_user_' || g);

-- 생성한 플레이어의 id 는 연속입니다(한 번의 INSERT ... generate_series). 아래에서
-- 무작위 작성자를 고를 때 이 범위 안에서만 골라야 FK 를 어기지 않습니다 —
-- 1..10000 을 그냥 쓰면 기존 플레이어 때문에 id 가 밀려 있어 깨집니다.
--
-- 서브쿼리가 아니라 psql 변수로 빼는 이유: 상관관계 없는 스칼라 서브쿼리는
-- InitPlan 으로 **한 번만** 평가될 수 있어서, 2만 행이 전부 같은 작성자가 될
-- 위험이 있습니다. 리터럴로 박아 두면 random() 이 행마다 돕니다.
SELECT min(id) AS lt_lo, max(id) AS lt_hi FROM players WHERE nickname LIKE 'loadtest_user_%'
\gset

-- ---------------------------------------------------------------------
-- 2. arcade_machines — 오락실당 기종 2~6개
--    /api/arcades 의 상관 서브쿼리가 실제로 무언가를 집계하게 만드는 핵심.
-- ---------------------------------------------------------------------
INSERT INTO arcade_machines (arcade_id, machine_id, updated_at)
SELECT a.id, m.id, now() - (random() * interval '200 days')
FROM arcades a
CROSS JOIN LATERAL (
  SELECT id FROM machines ORDER BY random() LIMIT 2 + (random() * 4)::int
) m
ON CONFLICT (arcade_id, machine_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. arcade_cabinets — 기종당 기체 1~3대
-- ---------------------------------------------------------------------
INSERT INTO arcade_cabinets (arcade_id, machine_id, cabinet_no, condition, updated_at)
SELECT am.arcade_id, am.machine_id, n,
       1 + (random() * 4)::int,
       now() - (random() * interval '60 days')
FROM arcade_machines am
CROSS JOIN LATERAL generate_series(1, 1 + (random() * 2)::int) n
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. machine_reports
--    (a) 1년치 누적 제보 25,000 — presence/absence/condition (만료 안 됨)
--    (b) 살아 있는 대기 제보 300 — 최근 4시간 (machine_live 가 실제로 집계)
-- ---------------------------------------------------------------------
INSERT INTO machine_reports (arcade_id, machine_id, player_id, kind, condition, created_at)
SELECT am.arcade_id, am.machine_id,
       :lt_lo + (random() * (:lt_hi - :lt_lo))::int,
       k.kind,
       CASE WHEN k.kind = 'condition' THEN 1 + (random() * 4)::int END,
       now() - (random() * interval '365 days')
-- arcade_machines 가 ~2,800행이라 LIMIT 25000 으로는 그만큼밖에 못 뽑습니다.
-- 조합 하나당 9건씩 곱해 1년치 누적(약 25,000건)을 만듭니다.
FROM arcade_machines am
CROSS JOIN LATERAL generate_series(1, 9) rep
-- 바깥 행을 참조해 **행마다** 평가되게 합니다. 상관관계가 없으면 Postgres 가
-- 이 LATERAL 을 한 번만 돌려서 2만 행이 전부 같은 kind 가 됩니다 (실제로 당했습니다).
CROSS JOIN LATERAL (
  SELECT (ARRAY['presence', 'presence', 'condition', 'absence'])[
           1 + (abs(hashtext(am.arcade_id::text || ':' || am.machine_id::text || ':' || rep::text)) % 4)
         ] AS kind
) k;

INSERT INTO machine_reports (arcade_id, machine_id, player_id, kind, wait_count, created_at)
SELECT am.arcade_id, am.machine_id,
       :lt_lo + (random() * (:lt_hi - :lt_lo))::int,
       'queue',
       (random() * 12)::int,
       now() - (random() * interval '240 minutes')
FROM (SELECT arcade_id, machine_id FROM arcade_machines ORDER BY random() LIMIT 300) am;

-- 만료 DELETE 가 실제로 지울 행도 남겨 둡니다 (4시간을 넘긴 대기 제보 500건).
-- purgeExpiredQueueReports 가 읽기 경로에서 도는 비용을 재려면 지울 게 있어야 합니다.
INSERT INTO machine_reports (arcade_id, machine_id, player_id, kind, wait_count, created_at)
SELECT am.arcade_id, am.machine_id,
       :lt_lo + (random() * (:lt_hi - :lt_lo))::int,
       'queue',
       (random() * 12)::int,
       now() - interval '5 hours' - (random() * interval '48 hours')
FROM (SELECT arcade_id, machine_id FROM arcade_machines ORDER BY random() LIMIT 500) am;

-- ---------------------------------------------------------------------
-- 5. arcade_reviews 6,000 (1인 1오락실)
-- ---------------------------------------------------------------------
INSERT INTO arcade_reviews (arcade_id, player_id, rating, body, created_at, updated_at)
SELECT a.id, p.id,
       1 + (random() * 4)::int,
       repeat('x', 120),
       now() - (random() * interval '300 days'),
       now()
FROM (SELECT id FROM arcades ORDER BY random() LIMIT 600) a
CROSS JOIN LATERAL (SELECT id FROM players ORDER BY random() LIMIT 10) p
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. arcade_favorites 15,000
-- ---------------------------------------------------------------------
INSERT INTO arcade_favorites (player_id, arcade_id, created_at)
SELECT p.id, a.id, now() - (random() * interval '300 days')
FROM (SELECT id FROM players ORDER BY random() LIMIT 3000) p
CROSS JOIN LATERAL (SELECT id FROM arcades ORDER BY random() LIMIT 5) a
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 7. posts 20,000 + post_comments 60,000
--
-- ⚠ like_count 는 난수로 채우지만 post_likes 행은 만들지 않습니다. 인기글 정렬
--   (posts_popular_idx)을 재는 데는 그 숫자만 있으면 되기 때문입니다. 대신 그 글에
--   추천을 한 번 누르면 recalc 이 실제 개수로 바로잡아 **숫자가 확 떨어집니다**
--   (21 → 1 을 실제로 봤습니다). 버그가 아니라 시드가 일관되지 않은 것입니다 —
--   추천 동작을 검증할 때는 이 점을 기억하세요.
--    DAU 3,000 에서 하루 55글쯤이면 1년에 이 정도입니다.
-- ---------------------------------------------------------------------
INSERT INTO posts (machine_id, category, player_id, title, body, body_doc,
                   comment_count, like_count, view_count, created_at, updated_at)
SELECT
  CASE WHEN random() < 0.8 THEN (SELECT id FROM machines ORDER BY random() LIMIT 1) END,
  (ARRAY['free', 'ask', 'info', 'guide', 'contest'])[1 + (random() * 4)::int],
  :lt_lo + (random() * (:lt_hi - :lt_lo))::int,
  'loadtest post title ' || g,
  repeat('x', :body_bytes),
  jsonb_build_object(
    'type', 'doc',
    'content', jsonb_build_array(jsonb_build_object(
      'type', 'paragraph',
      'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('x', :body_bytes)))
    ))
  ),
  0,
  (random() * 40)::int,
  (random() * 800)::int,
  now() - (random() * interval '365 days'),
  now()
FROM generate_series(1, 20000) g;

INSERT INTO post_comments (post_id, player_id, body, created_at, updated_at)
SELECT p.id,
       :lt_lo + (random() * (:lt_hi - :lt_lo))::int,
       repeat('x', 150),
       p.created_at + (random() * interval '10 days'),
       now()
FROM (SELECT id, created_at FROM posts WHERE title LIKE 'loadtest post title %') p
CROSS JOIN LATERAL generate_series(1, 1 + (random() * 5)::int) n;

UPDATE posts p
SET comment_count = c.n
FROM (SELECT post_id, count(*) AS n FROM post_comments GROUP BY post_id) c
WHERE c.post_id = p.id;

-- ---------------------------------------------------------------------
-- 8. clear_records 300,000 → difficulty_votes 150,000
--    투표는 클리어 기록에 복합 FK 로 묶여 있으므로 순서가 강제됩니다.
-- ---------------------------------------------------------------------
INSERT INTO clear_records (player_id, chart_id, cleared_at)
SELECT p.id, c.id, now() - (random() * interval '365 days')
FROM (SELECT id FROM players ORDER BY random() LIMIT 3000) p
CROSS JOIN LATERAL (SELECT id FROM charts ORDER BY random() LIMIT 100) c
ON CONFLICT DO NOTHING;

INSERT INTO difficulty_votes (player_id, chart_id, value, created_at, updated_at)
SELECT player_id, chart_id,
       ROUND((random() * 2 - 1)::numeric, 2),
       cleared_at,
       now()
FROM clear_records
WHERE random() < 0.5
ON CONFLICT DO NOTHING;

COMMIT;

ANALYZE;

-- ---------------------------------------------------------------------
-- 결과 확인
-- ---------------------------------------------------------------------
SELECT 'players' AS t, count(*) FROM players
UNION ALL SELECT 'arcade_machines', count(*) FROM arcade_machines
UNION ALL SELECT 'arcade_cabinets', count(*) FROM arcade_cabinets
UNION ALL SELECT 'machine_reports', count(*) FROM machine_reports
UNION ALL SELECT 'machine_reports(queue, live)', count(*) FROM machine_reports
  WHERE kind = 'queue' AND created_at > now() - interval '240 minutes'
UNION ALL SELECT 'machine_reports(queue, expired)', count(*) FROM machine_reports
  WHERE kind = 'queue' AND created_at <= now() - interval '240 minutes'
UNION ALL SELECT 'arcade_reviews', count(*) FROM arcade_reviews
UNION ALL SELECT 'arcade_favorites', count(*) FROM arcade_favorites
UNION ALL SELECT 'posts', count(*) FROM posts
UNION ALL SELECT 'post_comments', count(*) FROM post_comments
UNION ALL SELECT 'clear_records', count(*) FROM clear_records
UNION ALL SELECT 'difficulty_votes', count(*) FROM difficulty_votes
ORDER BY 1;
