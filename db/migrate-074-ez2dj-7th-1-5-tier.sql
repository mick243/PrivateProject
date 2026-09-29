-- ============================================================
-- 074 · EZ2DJ 7th TRAX Ver 1.5 서열표 (채보만 · 투표 없음)
--
-- ─── 무엇을 만드는가 ─────────────────────────────────────
-- EZ2DJ 의 세 번째 버전입니다. 1.5 는 새 게임이 아니라 **7th 의 확장판**이라
-- 060 이 넣은 1.0 채보 1,080개를 그대로 이어받고, 1.5 가 더한 것만 얹습니다.
--
--   곡 181개 (= 170 + 신곡 11) · 채보 1,213개 (= 1,080 + 17 + 116)
--
--   1,080  1.0 에서 그대로 온 것 (그중 한 칸만 레벨이 바뀝니다 — 아래 2 참고)
--     +17  1.5 가 더한 5Street 패턴
--    +116  신곡 11곡의 채보
--
-- 059 · 060 과 같이 **투표는 넣지 않아** 전부 '미정' 에서 시작합니다.
--
-- ─── 출처 ────────────────────────────────────────────────
-- 두 문서를 씁니다. 한 문서로는 안 됩니다.
--
--   ① 나무위키 『EZ2DJ 7th TRAX Ver 1.5』 4장 「신곡」
--      https://namu.wiki/w/EZ2DJ 7th TRAX Ver 1.5#s-4
--      → 신곡 11곡의 **이름**과, 그 아래 「1.5에서 추가된 5스트릿 패턴」 표 17줄
--        (레벨 · 난이도까지 다 있습니다). One Two Three Four 의 이지 변경도 여기.
--
--   ② 나무위키 『EZ2DJ 7th TRAX Ver 2.0/수록곡』 의 '7th TraX Ver 1.5' 구간
--      https://namu.wiki/w/EZ2DJ 7th TRAX Ver 2.0/수록곡
--      → 신곡 11곡의 **모드별 난이도 숫자**.
--
-- ─── ⚠ 신곡 난이도가 1.5 것이 아니라 2.01 것입니다 ───────
-- ①에는 신곡의 난이도 숫자가 **없습니다**. 곡명 · 장르 · 작곡가뿐입니다.
-- 1.5 전용 수록곡 문서도 없습니다 (『…Ver 1.5/수록곡』 = 문서 없음).
-- 그래서 숫자는 ②에서 가져오는데, 그 문서는 머리에 "2.01 버전을 기준으로 한다"
-- 고 적혀 있습니다. **1.5 당시 값과 다를 수 있습니다.**
--
-- 그대로 베끼지 않고 두 가지를 걸렀습니다.
--
--   ⓐ **1.5 에 없는 난이도 칸을 버립니다.** ②의 표는 가로 16칸인데 1.0(060)은
--      14칸입니다. 늘어난 둘이 **Ruby HD** 와 **7Street SHD** 입니다.
--      1.5 문서가 "추가된 패턴" 으로 적은 것은 5Street 열일곱뿐이라 이 둘은
--      2.0 에서 생긴 칸으로 보고 **넣지 않습니다.** 버린 칸은 11곡에 걸쳐 14개:
--        Ruby HD  6개 — An Old Story 3 · Black Bird 4 · Gray Hunter 7 ·
--                        Legend of Moonlight 8 · R.E.D. 5 · Prince of Darkness 6
--        7St SHD  8개 — An Old Story 8 · Gray Hunter 11 · Holic 11 ·
--                        Hyper Magic 15 · Legend of Moonlight 15 · Lucid 14 ·
--                        Never Feel This Way 12 · Prince of Darkness 14
--      덕분에 표 모양이 060 과 한 칸도 어긋나지 않습니다 — 아래 5) 의 컬럼
--      차례가 060 의 그것과 같아서 두 파일을 나란히 놓고 대조할 수 있습니다.
--
--   ⓑ **16레벨 두 칸은 `?` 로 둡니다.** 이 게임의 난이도는 1~15 인데(060 머리말)
--      ②의 표 전체 1,500여 칸 중 **딱 둘**이 16 입니다. 그 둘이 하필 1.5 신곡
--      입니다 — Hyper Magic 의 Space NM, Lucid 의 Club HD. 1.5 에 16 은 있을 수
--      없으니 2.0 에서 올린 값이고, 1.5 때 몇이었는지는 문서가 말하지 않습니다.
--      **채보는 있고 레벨만 모르는 것**이라 060 이 `?` 를 다룬 대로 level 을
--      NULL 로 넣어 `Lv.?` 칸에 모읍니다. 15 로 내려 적으면 없는 값을 짓는 것이고,
--      16 을 그대로 두면 1.5 표에 2.0 눈금이 섞입니다.
--
-- 나머지 숫자도 2.01 기준인 것은 같습니다. 1.5 만의 표가 나오면 5)의 표를
-- 통째로 갈아 끼우면 됩니다 — 아래는 한 줄이 문서 한 줄이라 대조가 쉽습니다.
--
-- ─── 1.0 에서 딱 한 칸이 바뀝니다 ────────────────────────
-- ①이 적은 그대로입니다 — "One Two Three Four의 이지와 노멀이 같던 것을 수정,
-- 이지에 루비 노멀 패턴을 넣었다". 1.0 에서 이 곡은 5Street EZ 와 NM 이 **둘 다
-- 5** 였고(060 의 표), 1.5 가 EZ 를 Ruby NM 패턴으로 갈았습니다. Ruby NM 은 3 이라
-- **5Street EZ 5 → 3**. 곡은 DB 표기로 `1234` 입니다 (060 의 별칭표).
--
-- ─── 곡 이름 ─────────────────────────────────────────────
-- 신곡 11곡은 기존 170곡과 겹치는 이름이 없어 별칭표가 필요 없습니다.
-- `R.E.D. ~Red Evil of Death~` 는 문서가 두 줄로 적은 것을 059 의 방식대로
-- 공백 하나로 이어 붙인 것입니다.
--
-- 17개 패턴이 붙을 곡은 전부 이미 있는 곡이라 **DB 표기**로 적습니다
-- (`Go !` · `Be-at feedback` · `Feel so sad` — 060 의 별칭표가 정한 이름입니다).
-- 열일곱 자리가 1.0 에서 모두 비어 있는 것은 DB 로 확인했습니다.
--
-- ─── 여러 번 실행해도 결과가 같습니다 ────────────────────
-- 행은 전부 ON CONFLICT DO NOTHING. 1234 의 EZ 는 **복사할 때 CASE 로 3 을 넣지**,
-- 넣고 나서 UPDATE 하지 않습니다 — UPDATE 로 하면 두 번째 실행 때 1.0 의 5 가
-- 다시 복사돼 EZ 채보가 둘이 됩니다 (열쇠에 레벨이 들어 있어 충돌하지 않습니다).
-- `level_label` 이 있는 DB 에서도 도는 이유는 059 · 060 머리말과 같습니다.
--
-- 되돌리려면: MIGRATION_FILES 에서 빼고 schema_migrations 에서 지운 뒤
--   DELETE FROM charts WHERE version_id =
--     (SELECT id FROM game_versions WHERE machine_id = 10 AND code = '7th1.5');
--   DELETE FROM game_versions WHERE machine_id = 10 AND code = '7th1.5';
--   DELETE FROM songs WHERE machine_id = 10 AND id NOT IN (SELECT song_id FROM charts);
-- ============================================================

-- ─── 1) 7th TRAX Ver 1.5 ──────────────────────────────────
-- 난이도 축(EZ · NM · HD · SHD)은 060 이 넣은 것을 그대로 씁니다.
INSERT INTO game_versions (machine_id, code, label, sort_order) VALUES
  (10, '7th1.5', '7th TRAX Ver 1.5', 3)
ON CONFLICT DO NOTHING;

-- ─── 2) 1.0 채보 1,080개를 그대로 이어받습니다 ────────────
-- 1.5 는 확장판이라 1.0 의 채보가 전부 그대로 있습니다. CASE 한 줄만 예외 —
-- 머리말의 'One Two Three Four' 항목입니다.
--
-- level_label 은 새로 짜지 않고 **1.0 의 것을 그대로 복사**합니다. level 이
-- NUMERIC 이라 `c.level::text` 로 만들면 `5.00` 이 되어 1.0 의 `5` 와 표기가
-- 갈립니다 (레벨 칸이 둘로 쪼개집니다). 레벨 미상인 셋의 `?` 도 함께 따라옵니다.
DO $copy$
DECLARE
  has_label BOOLEAN := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'charts' AND column_name = 'level_label'
  );
BEGIN
  EXECUTE format($q$
    INSERT INTO charts (song_id, version_id, mode, difficulty, level%s)
    SELECT c.song_id, v15.id, c.mode, c.difficulty,
           CASE WHEN s.title = '1234' AND c.mode = '5ST' AND c.difficulty = 'EZ'
                THEN 3 ELSE c.level END%s
    FROM charts c
    JOIN songs s           ON s.id  = c.song_id
    JOIN game_versions v10 ON v10.id = c.version_id
                          AND v10.machine_id = 10 AND v10.code = '7th'
    JOIN game_versions v15 ON v15.machine_id = 10 AND v15.code = '7th1.5'
    ON CONFLICT DO NOTHING
  $q$,
    CASE WHEN has_label THEN ', level_label' ELSE '' END,
    CASE WHEN has_label
         THEN ', CASE WHEN s.title = ''1234'' AND c.mode = ''5ST'' '
              'AND c.difficulty = ''EZ'' THEN ''3'' ELSE c.level_label END'
         ELSE '' END);
END
$copy$;

-- ─── 3) 1.5 가 더한 5Street 패턴 17개 ─────────────────────
-- ①의 「1.5에서 추가된 5스트릿 패턴」 표를 레벨 오름차순 그대로 옮긴 것입니다.
-- 비고란(NF-Special · Grotesque · 12+ 등)은 채보의 별명이라 넣지 않습니다 —
-- 서열표에 그 칸이 없고, 있다면 '특수패턴' 표시로 사람이 달 몫입니다.
CREATE TEMP TABLE ez2dj_15_added (title TEXT, mode TEXT, difficulty TEXT, level INT);

INSERT INTO ez2dj_15_added VALUES
  ('Cellavue'       , '5ST', 'HD' ,  7),
  ('Spotlight'      , '5ST', 'HD' ,  8),
  ('J.M.J'          , '5ST', 'SHD',  9),
  ('Memories'       , '5ST', 'SHD',  9),
  ('Complex'        , '5ST', 'SHD', 10),
  ('B.O.W.'         , '5ST', 'SHD', 10),
  ('빛바랜 영혼'       , '5ST', 'SHD', 10),
  ('Go !'           , '5ST', 'SHD', 10),
  ('Mad Robot'      , '5ST', 'SHD', 10),
  ('Back to Bed'    , '5ST', 'HD' , 11),
  ('Shout'          , '5ST', 'SHD', 11),
  ('Cosmic Bird'    , '5ST', 'SHD', 12),
  ('Climax'         , '5ST', 'SHD', 12),
  ('Be-at feedback' , '5ST', 'SHD', 13),
  ('Metagalactic'   , '5ST', 'SHD', 13),
  ('Feel so sad'    , '5ST', 'SHD', 13),
  ('Zeroize'        , '5ST', 'SHD', 14);

-- ─── 4) 신곡 11곡 · 출처 표 그대로 ────────────────────────
-- 컬럼 차례가 060 의 임시 표와 **같습니다**. 머리말 ⓐ 가 말한 대로 ②의 표에서
-- Ruby HD 와 7Street SHD 두 칸을 뺀 것이라 060 과 한 줄씩 대조할 수 있습니다.
--
--   Ruby │ 5Street E·N·H·S │ 7Street E·N·H │ Club N·H │ Space N·H │ Catch │ Turn
--
-- `-` 는 그 채보가 없다는 뜻, `?` 는 레벨을 모른다는 뜻입니다 (머리말 ⓑ 의 두 칸).
CREATE TEMP TABLE ez2dj_15_new (
  title TEXT,
  ruby_n TEXT,
  s5e TEXT, s5n TEXT, s5h TEXT, s5s TEXT,
  s7e TEXT, s7n TEXT, s7h TEXT,
  club_n TEXT, club_h TEXT,
  sp_n TEXT, sp_h TEXT,
  cat_n TEXT, turn_n TEXT
);

INSERT INTO ez2dj_15_new VALUES
  ('An Old Story'               , '1', '-', '3', '5', '-' , '-', '5', '7' , '5' , '-' , '7' , '-' , '6' , '4'),
  ('Black Bird'                 , '3', '4', '6', '8', '11', '7', '9', '11', '10', '-' , '12', '-' , '13', '7'),
  ('Gray Hunter'                , '5', '6', '8','10', '-' , '-', '7', '9' , '11', '-' , '13', '-' , '-' , '-'),
  ('Holic'                      , '7', '5', '7', '9', '11', '-', '6', '9' , '9' , '11', '9' , '14', '8' , '-'),
  ('Hyper Magic'                , '6', '5','11','13', '15', '7','12', '13', '13', '-' , '?' , '-' , '14', '14'),
  ('Legend of Moonlight'        , '6', '6', '9','11', '12', '-','11', '13', '12', '-' , '13', '15', '12', '14'),
  ('Lucid'                      , '8', '-','10','12', '14', '-','10', '13', '11', '?' , '13', '-' , '13', '10'),
  ('Never Feel This Way'        , '8', '-', '6', '9', '13', '-', '8', '10', '11', '-' , '13', '-' , '-' , '8'),
  ('R.E.D. ~Red Evil of Death~' , '3', '-', '5', '9', '12', '-', '7', '11', '11', '-' , '12', '-' , '10', '6'),
  ('Shot Time'                  , '4', '4', '5', '8', '-' , '-', '6', '10', '9' , '-' , '10', '-' , '9' , '-'),
  ('The Prince of Darkness'     , '2', '7', '9','12', '14', '8','11', '12', '12', '13', '15', '-' , '15', '-');

-- 곡은 이 11줄만 늘어납니다 (170 → 181).
INSERT INTO songs (machine_id, title, artist)
SELECT 10, title, NULL FROM ez2dj_15_new
ON CONFLICT DO NOTHING;

-- ─── 5) 채보 133개 (신곡 116 + 추가 패턴 17) ──────────────
-- 가로 14칸을 세로로 펼친 뒤 3) 의 열일곱과 한 자루에 담습니다.
CREATE TEMP TABLE ez2dj_15_charts AS
SELECT t.title,
       v.mode,
       v.difficulty,
       CASE WHEN v.val = '?' THEN NULL ELSE v.val::int END AS level
FROM ez2dj_15_new t
CROSS JOIN LATERAL (VALUES
  ('RUBY',  'NM',  t.ruby_n),
  ('5ST',   'EZ',  t.s5e),
  ('5ST',   'NM',  t.s5n),
  ('5ST',   'HD',  t.s5h),
  ('5ST',   'SHD', t.s5s),
  ('7ST',   'EZ',  t.s7e),
  ('7ST',   'NM',  t.s7n),
  ('7ST',   'HD',  t.s7h),
  ('CLUB',  'NM',  t.club_n),
  ('CLUB',  'HD',  t.club_h),
  ('SPACE', 'NM',  t.sp_n),
  ('SPACE', 'HD',  t.sp_h),
  ('CATCH', 'NM',  t.cat_n),
  ('TURN',  'NM',  t.turn_n)
) AS v(mode, difficulty, val)
WHERE v.val NOT IN ('X', '-', '');

INSERT INTO ez2dj_15_charts (title, mode, difficulty, level)
SELECT title, mode, difficulty, level FROM ez2dj_15_added;

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
    FROM ez2dj_15_charts e
    JOIN songs s          ON s.machine_id  = 10 AND s.title = e.title
    JOIN game_versions gv ON gv.machine_id = 10 AND gv.code = '7th1.5'
    ON CONFLICT DO NOTHING
  $q$,
    CASE WHEN has_label THEN ', level_label'                    ELSE '' END,
    CASE WHEN has_label THEN ', COALESCE(e.level::text, ''?'')' ELSE '' END);
END
$mig$;

DROP TABLE ez2dj_15_charts;
DROP TABLE ez2dj_15_added;
DROP TABLE ez2dj_15_new;

-- ─── 6) 집계 캐시 초기화 ──────────────────────────────────
-- 투표가 없으므로 전부 tier_code = 'undecided' 가 됩니다 (059 · 060 과 같은 마무리).
SELECT recalc_chart_stats(c.id)
FROM charts c JOIN songs s ON s.id = c.song_id
WHERE s.machine_id = 10;
