-- ============================================================
-- 079 · AEIC 의 빈자리 넷을 채웁니다 (AE 리믹스 4곡 · 채보 32개)
--
-- ─── 무엇을 만드는가 ─────────────────────────────────────
-- 078 이 AEIC 를 넣으면서 **네 곡을 넣지 못했습니다.** AE 시절 리믹스인데
-- 난이도를 빌려 온 EC 표에서 지워졌고 DB 의 앞 버전에도 없어, (모드, 레벨)을
-- 어디서도 구할 수 없었습니다. 그 넷을 이제 채웁니다.
--
--   20000000000 (Hurt Bass Remix) · Anemia (Synth Pop Remix) ·
--   Back to Bed (Crimson Red Remix) · I Do Love You (Insida Club Remix)
--
-- 이걸로 AEIC 는 **곡 235개 · 채보 2,320개**가 되어 수록곡 문서의 명단과 같아집니다.
--
-- ─── 출처 ────────────────────────────────────────────────
--   나무위키 『EZ2DJ : AZURE EXPRESSION』 5.1장 「신곡 / 신패턴 난이도표」의 이미지
--   https://namu.wiki/w/EZ2DJ : AZURE EXPRESSION#s-5.1
--
-- 글이 아니라 **표를 찍은 그림 한 장**입니다 (858×1281). 그 안의 '신곡' 구획에
-- 네 곡이 한 줄씩 있습니다. 나머지 구획('구곡 추가 패턴' · '구곡 난이도 변경')은
-- AE 가 구곡에 한 손질이라 078 이 EC 에서 가져온 값에 이미 반영돼 있습니다.
--
-- ─── ⚠ 이 값은 필드 테스트판 것입니다 ────────────────────
-- 그림 위에 **"필드 테스트판의 곡 목록"** 이라고 적혀 있습니다. 정식판에서 바뀌었을
-- 수 있습니다. 078 의 숫자가 EC(다음 세대) 기준이라 이미 근사값인데, 이 넷은
-- **출처가 한 겹 더 멉니다.** 그래도 "채보가 있는데 어디에도 놓이지 못하는" 것보다는
-- 낫다고 보고 넣습니다. 정식판 표가 나오면 이 파일만 다시 쓰면 됩니다.
--
-- ─── 그림의 표는 가로 18칸입니다 ─────────────────────────
--   5Keys E·N·H·S │ 7Keys E·N·H·S │ Club E·N·H │ Space N·H │ Catch N·H │ Turn E·N·H
--
-- **Ruby 칸이 아예 없습니다.** 그래서 이 넷에는 Ruby 채보를 넣지 않습니다.
-- Catch 는 N·H 뿐이고(EZ 없음), Turn 에는 EZ 가 있지만 네 곡 모두 `-` 라
-- 078 이 쓰는 20칸 밖으로 나가는 값은 하나도 없습니다.
--
-- ─── 곡 이름은 AEIC 문서 표기를 씁니다 ───────────────────
-- 그림은 `20000000000 -Hurt Bass Remix-` 처럼 대시로 감싸 적지만, 이 버전의 곡
-- 명단은 AEIC 수록곡 문서가 정본이라 그쪽 표기(괄호)를 씁니다 — 078 과 같습니다.
--
-- ─── 여러 번 실행해도 결과가 같습니다 ────────────────────
-- 곡·채보 모두 ON CONFLICT DO NOTHING. 네 곡은 078 이 넣지 않았으므로 여기서
-- 처음 생깁니다.
--
-- 되돌리려면: MIGRATION_FILES 에서 빼고 schema_migrations 에서 지운 뒤
--   DELETE FROM charts c USING songs s, game_versions v
--     WHERE c.song_id = s.id AND c.version_id = v.id
--       AND v.machine_id = 10 AND v.code = 'AEIC'
--       AND s.title IN ('20000000000 (Hurt Bass Remix)', 'Anemia (Synth Pop Remix)',
--                       'Back to Bed (Crimson Red Remix)', 'I Do Love You (Insida Club Remix)');
--   DELETE FROM songs WHERE machine_id = 10 AND id NOT IN (SELECT song_id FROM charts);
-- ============================================================

-- ─── 1) 그림의 네 줄 그대로 ───────────────────────────────
-- 컬럼 차례가 그림의 가로 차례와 같습니다 (Ruby 가 없으므로 5Keys 부터).
CREATE TEMP TABLE ez2dj_ae_remix (
  title TEXT,
  s5e TEXT, s5n TEXT, s5h TEXT, s5s TEXT,
  s7e TEXT, s7n TEXT, s7h TEXT, s7s TEXT,
  club_e TEXT, club_n TEXT, club_h TEXT,
  sp_n TEXT, sp_h TEXT,
  cat_n TEXT, cat_h TEXT,
  turn_e TEXT, turn_n TEXT, turn_h TEXT
);

INSERT INTO ez2dj_ae_remix VALUES
  ('I Do Love You (Insida Club Remix)', '-',  '7', '10', '-', '-',  '7', '10', '-', '-',  '-',  '-',  '9', '-',  '9', '-', '-',  '7', '-'),
  ('Anemia (Synth Pop Remix)'         , '-',  '7', '10', '-', '-',  '8', '10', '-', '-', '12',  '-', '11', '-',  '8', '-', '-', '10', '-'),
  ('Back to Bed (Crimson Red Remix)'  , '-', '10', '13', '-', '-', '10', '12', '-', '-', '10', '14', '12', '-', '10', '-', '-', '11', '-'),
  ('20000000000 (Hurt Bass Remix)'    , '-', '10', '13', '-', '-', '12', '14', '-', '-', '14',  '-', '15', '-', '13', '-', '-', '15', '-');

-- ─── 2) 곡 넷 ─────────────────────────────────────────────
INSERT INTO songs (machine_id, title, artist)
SELECT 10, title, NULL FROM ez2dj_ae_remix
ON CONFLICT DO NOTHING;

-- ─── 3) 채보 32개 ─────────────────────────────────────────
CREATE TEMP TABLE ez2dj_ae_remix_charts AS
SELECT t.title, v.mode, v.difficulty, v.val::int AS level
FROM ez2dj_ae_remix t
CROSS JOIN LATERAL (VALUES
  ('5ST',   'EZ',  t.s5e),
  ('5ST',   'NM',  t.s5n),
  ('5ST',   'HD',  t.s5h),
  ('5ST',   'SHD', t.s5s),
  ('7ST',   'EZ',  t.s7e),
  ('7ST',   'NM',  t.s7n),
  ('7ST',   'HD',  t.s7h),
  ('7ST',   'SHD', t.s7s),
  ('CLUB',  'EZ',  t.club_e),
  ('CLUB',  'NM',  t.club_n),
  ('CLUB',  'HD',  t.club_h),
  ('SPACE', 'NM',  t.sp_n),
  ('SPACE', 'HD',  t.sp_h),
  ('CATCH', 'NM',  t.cat_n),
  ('CATCH', 'HD',  t.cat_h),
  ('TURN',  'EZ',  t.turn_e),
  ('TURN',  'NM',  t.turn_n),
  ('TURN',  'HD',  t.turn_h)
) AS v(mode, difficulty, val)
WHERE v.val NOT IN ('X', '-', '');

DO $mig$
DECLARE
  has_label BOOLEAN := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'charts' AND column_name = 'level_label'
  );
BEGIN
  EXECUTE format($q$
    INSERT INTO charts (song_id, version_id, mode, difficulty, level%s)
    SELECT s.id, gv.id, e.mode, e.difficulty, e.level%s
    FROM ez2dj_ae_remix_charts e
    JOIN songs s          ON s.machine_id  = 10 AND s.title = e.title
    JOIN game_versions gv ON gv.machine_id = 10 AND gv.code = 'AEIC'
    ON CONFLICT DO NOTHING
  $q$,
    CASE WHEN has_label THEN ', level_label'   ELSE '' END,
    CASE WHEN has_label THEN ', e.level::text' ELSE '' END);
END
$mig$;

DROP TABLE ez2dj_ae_remix_charts;
DROP TABLE ez2dj_ae_remix;

-- ─── 4) 집계 캐시 초기화 ──────────────────────────────────
SELECT recalc_chart_stats(c.id)
FROM charts c JOIN songs s ON s.id = c.song_id
WHERE s.machine_id = 10;
