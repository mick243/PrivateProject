-- ============================================================
-- 059 · EZ2DJ 6th TRAX ~Self Evolution~ 서열표 (채보만 · 투표 없음)
--
-- ─── 무엇을 만드는가 ─────────────────────────────────────
-- EZ2DJ(machines.id 10) 의 첫 서열표. 곡 138개 · 채보 **837개**.
-- **투표는 넣지 않습니다** — 전부 '미정' 칸에서 시작합니다 (018 · 028 · 047 과
-- 같은 방식). 등급은 이 서비스의 투표가 쌓이면서 정해집니다.
--
-- ─── 출처 ────────────────────────────────────────────────
--   나무위키 『EZ2DJ 6th TRAX ~Self Evolution~/수록곡』 2장 **곡별 난이도 정보**
--   https://namu.wiki/w/EZ2DJ 6th TRAX ~Self Evolution~/수록곡
--
-- 같은 문서 3장의 '곡별 노트 수 정보' 표는 쓰지 않았습니다 — 모양이 똑같아서
-- 헷갈리기 쉽지만 그쪽 숫자는 노트 수입니다.
--
-- 표는 가로로 9칸이고, 아래 임시 표의 컬럼 순서가 그 차례 그대로입니다.
--
--   Ruby │ 5Street N · H │ 7Street │ Club │ Space N · H │ Catch │ Turn
--
--   `X` 는 그 채보가 없다는 뜻이고, 숫자가 난이도입니다. **두 자리(10~13)도 그대로
--   읽었습니다** — 이 버전은 레벨이 13까지 있습니다.
--
-- ⚠ 표에 아티스트가 없어 songs.artist 는 전부 NULL 입니다 (추측해 채우지 않습니다).
--
-- ─── ? 난이도 3개는 따로 모읍니다 ────────────────────────
-- Space H 칸이 `?` 인 채보가 셋 있습니다 — `Look Out` · `Dieoxin` · `Frantic`.
-- **채보는 있는데 난이도만 모르는 것**이라 빼지 않고 `charts.level` 을 NULL 로
-- 넣습니다. 그래서 레벨 선택기에 `SPACE?` 칸이 하나 생기고 셋이 거기 모입니다.
--
-- level 의 NOT NULL 을 뗍니다. 047 이 '난이도 미표기' 를 담으려고 mode 의
-- NOT NULL 을 뗀 것과 같은 처리입니다 — 숫자를 지어내 채우면 없는 난이도가
-- 조용히 섞이고, 빼면 채보가 사라집니다.
--
-- ─── ⚠ 레벨 상한을 30 → 99 로 올립니다 ───────────────────
-- `Theme of Ez2Dj` 의 5Street 히든 채보가 표에 **99** 로 적혀 있습니다. 이 게임이
-- 실제로 그렇게 표시하는 값이라 그대로 넣습니다. 기존 CHECK(1~30)에 걸리므로
-- 상한만 올립니다 — 하한 1 은 그대로입니다.
--
-- ─── 같은 곡이 두 줄인 9곡 ───────────────────────────────
-- `Theme of Ez2Dj` · `Bacardi on the Beach` · `Frantic` · `1234` ·
-- `Baby Dance Club Ver.` · `I've got this feeling Extended Ver.` ·
-- `Jam A.C. Ver.` · `The Boy EK2-Beat Ver.` · `With you Girl Beach Ver.`
--
-- 둘째 줄은 5Street 칸에만 값이 있는 히든 패턴입니다. **같은 곡의 채보 하나 더**로
-- 넣습니다 — 곡을 둘로 쪼개면 같은 이름의 songs 행이 두 개가 되고
-- (machine_id, title) UNIQUE 에 걸립니다. 같은 (곡, 모드, 난이도)라도 레벨이
-- 달라서 채보 UNIQUE 에는 걸리지 않습니다.
--
-- ─── 곡명이 두 줄인 17곡 ─────────────────────────────────
-- 리믹스 부제가 둘째 줄에 있습니다. **공백 하나로 이어 붙였습니다** —
-- 같은 문서가 `Confete ~ Remix ~` 처럼 한 줄로 적은 곡도 있어서, 그 표기와
-- 모양이 같아집니다 (`Mystic Dream 9903 ~ Horror mix ~`). 원곡과 이름이 겹치지
-- 않는 것은 확인했습니다 (`Aquaris` vs `Aquaris Physical Inspiration…`).
--
-- ─── 축이 셋입니다: 버전 · 모드 · 난이도 ─────────────────
-- 이 게임 하나를 담으려고 서열표에 축을 둘 더합니다.
--
--   game_versions        기종 안의 버전 (6th TRAX …). charts.version_id 가 가리키고
--                        NULL 이면 버전을 구분하지 않는 게임이다 (펌프 · 사볼).
--   machine_difficulties 한 모드 안에서 곡마다 갈리는 채보 (NM · HD).
--                        charts.difficulty 가 가리키고 NULL 이면 그 축이 없다.
--
-- **버전**: EZ2DJ 는 한 기종 이름 아래 1st·2nd·…·6th 가 이어지고 같은 곡의 채보가
-- 버전마다 다릅니다. 구분하지 않으면 나중에 다른 버전을 넣을 때 한 칸에 섞입니다.
--
-- **난이도**: 모드는 *무엇을 플레이하는가*(Ruby·Club·Space…)고 난이도는 *같은 곡의
-- 어느 채보인가*(NM·HD)입니다. 모드로 뭉뚱그려 `5ST-NM`·`5ST-HD` 처럼 9개를 만들면
--   1. 같은 레벨끼리 비교할 수 없게 됩니다 — `5Street NM 8` 과 `5Street HD 8` 은 둘 다
--      5키 스트리트 8레벨이라 **한 표에서** 비교해야 합니다 (045 의 판단과 같습니다).
--   2. ⚠ **채보가 조용히 사라집니다.** `Complex` 는 Space NM 과 HD 가 **둘 다 10** 이라
--      난이도를 빼면 UNIQUE 에 걸려 ON CONFLICT DO NOTHING 이 뒤엣것을 버립니다.
-- 그래서 보드는 (모드, 레벨)로 두고 난이도는 사볼처럼 곡명 뒤 대괄호로 보여줍니다.
--
-- ⚠ 이름은 EZ2 시리즈 관례를 따라 `NM`(Normal) · `HD`(Hard) 로 넣었습니다. 표 자체는
--   한 글자(N · H)로 적지만 7th 가 넷으로 늘어나면 EZ · NM · HD · SHD 가 되므로
--   (060) 처음부터 그 이름으로 맞춰 둡니다. 바꾸려면 `machine_difficulties.code` 와
--   `charts.difficulty` 를 같이 UPDATE 해야 합니다 — FK 가 없어 따로 놉니다.
--
-- ⚠ 사볼은 이 컬럼으로 옮기지 않습니다. 사볼은 모드 축이 **아예 없어서**
--   `tier_settings.mode_is_difficulty` 로 charts.mode 를 난이도로 읽는 지름길을
--   쓰고 있고(045) 그게 지금도 맞습니다. 두 축이 다 있는 게임은 EZ2DJ 가 처음입니다.
--
-- ─── 등급은 5단 ──────────────────────────────────────────
-- 최상 · 상 · 중 · 하 · 최하. anchor 간격이 0.50 이라 tier_step(0.50)과 정확히
-- 맞고, 등급 띠가 투표 범위(-1.00 ~ +1.00)를 빈틈없이 덮습니다.
--
--   최상 +1.00  (+0.75 ~ +1.00]        하   -0.50  [-0.75 ~ -0.25)
--   상   +0.50  (+0.25 ~ +0.75]        최하 -1.00  [-1.00 ~ -0.75)
--   중    0.00  [-0.25 ~ +0.25]
--
-- 사볼의 8단은 한 레벨에 수백 곡이 몰려 '중' 한 칸이 40% 를 먹어서 올린 것입니다
-- (043). 여기는 보드 77칸에 837채보라 가장 두꺼운 칸이 42곡(5Street 6·7레벨),
-- 중앙값이 7곡입니다. 5칸이면 한 칸에 평균 8곡으로 충분히 갈립니다.
--
-- min_convergence 는 5단 기준인 0.20 입니다(7단인 펌프는 0.30). 등급 폭이 0.50 이라
-- 표준편차가 0.40 을 넘으면 '개인차' 로 갑니다.
--
-- ─── chart_basis 는 비워 둡니다 ──────────────────────────
-- 044 가 만든 그 칸은 "이 게임의 채보를 어느 버전에서 모았나" 를 적는 자리인데,
-- EZ2DJ 는 그 버전이 화면의 선택기로 올라오므로 같은 말이 두 번 나옵니다.
--
-- ─── 여러 번 실행해도 결과가 같습니다 ────────────────────
-- 표·컬럼은 IF NOT EXISTS, 행은 전부 ON CONFLICT DO NOTHING.
-- 출처 표에 (곡, 모드, 난이도, 레벨)이 완전히 같은 줄은 없는 것을 확인했습니다 —
-- 있었다면 ON CONFLICT 가 조용히 버렸을 것입니다.
--
-- ⚠ **`level_label` 이 있는 DB 에서도 돕니다.** 다른 브랜치의
--   migrate-058-chart-level-notation 이 charts 에 NOT NULL 컬럼을 하나 더 만드는데,
--   그것이 적용된 개발 DB 에 이 파일을 그냥 돌리면 INSERT 가 막힙니다 (워크트리들이
--   개발 DB 하나를 함께 봅니다 — GUIDELINES 6장). 그래서 아래 INSERT 는 컬럼이
--   있으면 값을 함께 넣고, 레벨이 NULL 인 셋은 이름을 '?' 로 답니다.
--   charts 의 UNIQUE 도 그 컬럼이 있으면 `(song_id, version_id, mode, difficulty,
--   level_label)` 한 벌로 정리합니다 — 아래 4) 참고. 058 의 제약을 그대로 두면
--   난이도가 빠진 열쇠라 채보가 하나 조용히 사라집니다.
--
-- 되돌리려면: MIGRATION_FILES 에서 빼고 schema_migrations 에서 지운 뒤
--   DELETE FROM charts WHERE version_id IN
--     (SELECT id FROM game_versions WHERE machine_id = 10);
--   DELETE FROM songs                WHERE machine_id = 10;
--   DELETE FROM tier_grades          WHERE machine_id = 10;
--   DELETE FROM tier_settings        WHERE machine_id = 10;
--   DELETE FROM machine_modes        WHERE machine_id = 10;
--   DELETE FROM machine_difficulties WHERE machine_id = 10;
--   DROP TABLE game_versions CASCADE;
--   (charts 의 UNIQUE · level 상한 · NOT NULL 해제는 되돌리지 않아도 무해합니다.)
-- ============================================================

-- ─── 1) 버전 축 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_versions (
  id         SERIAL  PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  -- code 는 적재 파일이 채보를 붙일 때 쓰는 열쇠입니다 (주소에 실리는 것은 id).
  code       TEXT    NOT NULL,
  label      TEXT    NOT NULL,   -- 화면 표기
  sort_order INTEGER NOT NULL,   -- 1 = 가장 오래된 버전
  UNIQUE (machine_id, code),
  UNIQUE (machine_id, sort_order)
);

ALTER TABLE charts ADD COLUMN IF NOT EXISTS version_id INTEGER
  REFERENCES game_versions(id) ON DELETE CASCADE;

COMMENT ON COLUMN charts.version_id IS
  'game_versions.id. NULL 은 버전을 구분하지 않는 게임(펌프·사볼)이다.';

-- 서열표 조회가 (기종, 버전, 모드, 레벨)로 좁혀 들어온다.
CREATE INDEX IF NOT EXISTS charts_version_idx ON charts (version_id);

-- ─── 2) 난이도 축 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machine_difficulties (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  code       TEXT    NOT NULL,   -- charts.difficulty 에 들어가는 값
  label      TEXT    NOT NULL,   -- UI 표기
  sort_order INTEGER NOT NULL,   -- 1 = 가장 쉬운 쪽
  PRIMARY KEY (machine_id, code),
  UNIQUE (machine_id, sort_order)
);

ALTER TABLE charts ADD COLUMN IF NOT EXISTS difficulty TEXT;

COMMENT ON COLUMN charts.difficulty IS
  'machine_difficulties.code. NULL 은 그 채보에 난이도 구분이 없다는 뜻이다 '
  '(펌프 · 사볼). 사볼은 mode 쪽에 난이도가 들어 있다 — migrate-045.';

-- ─── 3) 레벨 — 미상(NULL) 허용 · 상한 99 ──────────────────
ALTER TABLE charts ALTER COLUMN level DROP NOT NULL;

COMMENT ON COLUMN charts.level IS
  '난이도 숫자. NULL 은 ''난이도 미상'' 이고 서열표에서 별도 칸(?)으로 모인다.';

-- 상한만 올린다. NULL 은 CHECK 가 NULL 을 내 통과하므로 따로 손댈 것이 없다.
ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_level_check;
ALTER TABLE charts ADD  CONSTRAINT charts_level_check CHECK (level >= 1 AND level <= 99);

-- ─── 4) 채보의 열쇠 ───────────────────────────────────────
-- 같은 곡이라도 버전 · 모드 · 난이도 · 층 중 하나라도 다르면 다른 채보다.
-- NULLS NOT DISTINCT — NULL 끼리도 같은 값으로 봐야 재실행이 중복을 만들지 않는다
-- (버전 없는 게임의 version_id, 난이도 없는 게임의 difficulty, 미상인 level).
--
-- ⚠ **옛 제약을 전부 걷어내고 한 벌로 만듭니다.** 특히 058(chart-level-notation)의
--   `(song_id, mode, level_label)` 은 난이도 축을 모릅니다 — 그대로 두면
--   `Complex` 의 Space NM 10 과 HD 10 이 같은 열쇠가 되어 **뒤엣것이 조용히
--   버려집니다**(837 → 836. 합쳐 보고 실제로 확인했습니다).
--
-- 층은 `level_label` 이 있으면 그쪽으로 잡습니다 — 058 이 나눈 이유(13 과 13+ 는
-- 다른 층)를 그대로 지키면서 버전·난이도만 더하는 것입니다. 그 컬럼이 없는
-- DB(이 브랜치만 있는 경우)에서는 `level` 로 잡습니다.
DO $key$
DECLARE
  has_label BOOLEAN := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'charts' AND column_name = 'level_label'
  );
BEGIN
  EXECUTE 'ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_song_id_mode_level_key';
  EXECUTE 'ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_song_id_mode_level_label_key';
  EXECUTE 'ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_song_version_mode_diff_level_key';
  EXECUTE format(
    'ALTER TABLE charts ADD CONSTRAINT charts_song_version_mode_diff_level_key '
    'UNIQUE NULLS NOT DISTINCT (song_id, version_id, mode, difficulty, %s)',
    CASE WHEN has_label THEN 'level_label' ELSE 'level' END);
END
$key$;

-- ─── 5) 모드 7개 · 난이도 2개 ─────────────────────────────
-- 표기는 화면에 그대로 나갑니다 (`7 Street Lv.3`). 출처 표의 열 이름은 붙여 쓴
-- `5Street`·`7Street` 인데, 게임이 부르는 이름은 띄어 쓰는 쪽이라 그렇게 뒀습니다 —
-- 코드(5ST·7ST)는 주소와 DB 의 열쇠라 그대로입니다.
INSERT INTO machine_modes (machine_id, code, label, sort_order) VALUES
  (10, 'RUBY',  'Ruby',     1),
  (10, '5ST',   '5 Street', 2),
  (10, '7ST',   '7 Street', 3),
  (10, 'CLUB',  'Club',     4),
  (10, 'SPACE', 'Space',    5),
  (10, 'CATCH', 'Catch',    6),
  (10, 'TURN',  'Turn',     7)
ON CONFLICT DO NOTHING;

INSERT INTO machine_difficulties (machine_id, code, label, sort_order) VALUES
  (10, 'NM', 'NM', 1),
  (10, 'HD', 'HD', 2)
ON CONFLICT DO NOTHING;

-- ─── 6) 등급 5단 ──────────────────────────────────────────
INSERT INTO tier_grades (machine_id, code, label, anchor, sort_order) VALUES
  (10, 'ss', '최상',  1.00, 1),
  (10, 's',  '상',    0.50, 2),
  (10, 'a',  '중',    0.00, 3),
  (10, 'b',  '하',   -0.50, 4),
  (10, 'c',  '최하', -1.00, 5)
ON CONFLICT DO NOTHING;

-- ─── 7) 집계 임계값 ───────────────────────────────────────
-- 투표 범위는 숫자를 박지 않고 방금 넣은 anchor 의 최소·최대에서 끌어옵니다 —
-- 034 가 두 게임에 한 것과 같은 방식이라, 등급 스케일을 고치면 범위도 따라옵니다.
INSERT INTO tier_settings
  (machine_id, vote_min, vote_max, vote_step, tier_step, min_votes, min_convergence, special_min)
SELECT 10, MIN(anchor), MAX(anchor), 0.10, 0.50, 3, 0.20, 3
FROM tier_grades WHERE machine_id = 10
ON CONFLICT (machine_id) DO NOTHING;

-- ─── 8) 6th TRAX ──────────────────────────────────────────
INSERT INTO game_versions (machine_id, code, label, sort_order) VALUES
  (10, '6th', '6th TRAX', 1)
ON CONFLICT DO NOTHING;

-- ─── 9) 출처 표 그대로 ────────────────────────────────────
-- 컬럼 차례가 문서의 가로 차례와 같습니다. 한 줄이 문서의 한 줄이라 그대로 대조할
-- 수 있습니다 — 곡 목록도 채보도 여기서 만들어집니다.
CREATE TEMP TABLE ez2dj_6th (
  title TEXT,
  ruby TEXT, s5n TEXT, s5h TEXT, s7n TEXT, club TEXT, spn TEXT, sph TEXT, cat TEXT, turn TEXT
);

INSERT INTO ez2dj_6th VALUES
  -- ── The 1st Tracks ──
  ('Baby Dance'                                         ,  '4',  '4',  'X',  '4',  '4',  'X',  'X',  'X',  'X'),
  ('Catch The Flow'                                     ,  '4',  '4',  '5',  '6',  '5',  'X',  'X',  'X',  'X'),
  ('Confete'                                            ,  '4',  '2',  'X',  '3',  '3',  'X',  'X',  '4',  'X'),
  ('Dirty - D'                                          ,  '3',  '2',  '5',  '6',  '7',  'X',  'X',  'X',  'X'),
  ('Envy Mask'                                          ,  '5',  '6',  '7',  '8',  '8',  '7',  'X',  'X',  'X'),
  ('Funny Funky'                                        ,  '4',  '3',  'X',  '3',  '3',  'X',  'X',  'X',  'X'),
  ('Get the Beat'                                       ,  '1',  '1',  '7',  '3',  '2',  'X',  'X',  'X',  'X'),
  ('I Do Love You'                                      ,  '3',  '3',  '5',  '3',  '5',  'X',  'X',  'X',  'X'),
  ('I''ve Fallen'                                       ,  '4',  '3',  'X',  '3',  '3',  'X',  'X',  'X',  'X'),
  ('Look Out'                                           ,  '1',  '3',  '5',  '5',  '7',  'X',  '?',  '5',  'X'),
  ('Minus 1'                                            ,  '5',  '6',  '7',  '6',  '8',  'X',  'X',  'X',  'X'),
  ('Quake in Kyoto'                                     ,  '6',  '6', '10',  '6',  '6',  '8',  'X',  'X',  'X'),
  ('Southwest Cadillac'                                 ,  '4',  '3',  '6',  '5',  '6',  'X',  'X',  'X',  'X'),
  ('Stay'                                               ,  '5',  '5',  '8',  '5',  '5',  'X',  'X',  '6',  'X'),
  ('The Rhythm'                                         ,  '3',  '5',  '6',  '7',  '7',  '7',  'X',  '7',  'X'),
  ('Yes Yes'                                            ,  '1',  '1',  'X',  '3',  '3',  'X',  'X',  'X',  'X'),
  ('You love the life you live'                         ,  '1',  '1',  'X',  '3',  '3',  'X',  'X',  'X',  'X'),
  ('Ztar warZ'                                          ,  '6',  '7',  '9',  '9',  '9', '11',  'X',  'X',  'X'),
  -- ── The 1st Tracks Special Edition ──
  ('Combination'                                        ,  '2',  '4',  'X',  '3',  '6',  'X',  'X',  'X',  'X'),
  ('Dieoxin'                                            ,  '6',  '7', '12',  '8',  '9', '10',  '?',  'X',  'X'),
  ('R.D.M.'                                             ,  '5',  '4',  'X',  '5',  '6',  'X',  'X',  'X',  'X'),
  ('Red Hot'                                            ,  '6',  '5',  'X',  '6',  '7',  'X',  'X',  'X',  'X'),
  ('Special K'                                          ,  '4',  '3',  'X',  '3',  '4',  'X',  'X',  'X',  'X'),
  ('The Future'                                         ,  '5',  '5', '10',  '6',  '6',  '7',  'X',  'X',  'X'),
  ('Confete ~ Remix ~'                                  ,  '5',  '4',  'X',  '4',  '4',  'X',  'X',  'X',  'X'),
  ('Do you remember ? ~ Remix ~'                        ,  '5',  '5',  'X',  '6',  '6',  'X',  'X',  'X',  'X'),
  ('Let It Go ~ Remix ~'                                ,  '6',  '4',  'X',  '6',  '6',  'X',  'X',  'X',  'X'),
  ('Mystic Dream 9903 ~ Horror mix ~'                   ,  '8',  '6',  '8',  '7',  '7',  'X',  'X',  'X',  'X'),
  ('Stay ~ Radio Edit ~'                                ,  'X',  'X',  'X',  'X',  'X',  '7',  'X',  'X',  'X'),
  ('You love the life you live ~ Remix ~'               ,  '3',  '5',  'X',  '4',  '4',  'X',  'X',  'X',  'X'),
  -- ── 2nd TraX ──
  ('Anytime'                                            ,  '7',  '6',  '7',  '6',  '8',  '8',  'X',  'X',  'X'),
  ('Appeal'                                             ,  '3',  '6',  '8',  '5',  '6',  'X',  'X',  'X',  '7'),
  ('Back for more'                                      ,  '2',  '6',  'X',  '5',  '6',  'X',  'X',  '5',  'X'),
  ('Back to Bed'                                        ,  '6',  '7',  'X',  '7',  '7',  'X',  'X',  'X',  'X'),
  ('Be my baby'                                         ,  '3',  '3',  '4',  '5',  '4',  'X',  'X',  '4',  'X'),
  ('Damnation'                                          ,  '6',  '6',  'X',  '7',  '8',  '8',  'X',  'X',  'X'),
  ('Departure'                                          ,  '5',  '4',  'X',  '5',  '8',  'X',  'X',  'X',  'X'),
  ('Exist'                                              ,  '5',  '3',  '6',  '6',  '6',  'X',  'X',  'X',  '5'),
  ('Funky 5'                                            ,  '1',  '4',  'X',  '4',  '4',  'X',  'X',  '3',  'X'),
  ('Get it up'                                          ,  '6',  '5',  'X',  '6',  '6',  'X',  'X',  'X',  'X'),
  ('Hypnotize'                                          ,  '8',  '6',  '9',  '7',  '7',  'X',  'X',  'X',  'X'),
  ('It''s my secret'                                    ,  '4',  '4',  '6',  '6',  '7',  'X',  'X',  'X',  'X'),
  ('I''ve got this feeling'                             ,  '4',  '4',  'X',  '3',  '4',  'X',  'X',  'X',  'X'),
  ('Jam'                                                ,  '5',  '4',  'X',  '4',  '4',  'X',  'X',  '6',  '6'),
  ('Minus 1 ~ space mix ~'                              ,  '7',  '8', '11',  '8',  '9', '11',  'X',  'X',  'X'),
  ('Moving On'                                          ,  '1',  '1',  '5',  '6',  '6',  'X',  'X',  'X',  'X'),
  ('Red Ocean'                                          ,  '6',  '6',  'X',  '6',  '7',  '9',  'X',  'X',  'X'),
  ('Say That U'                                         ,  '3',  '5',  '6',  '6',  '7',  '7',  'X',  '7',  '8'),
  ('Seize the day'                                      ,  '3',  '2',  '5',  '5',  '5',  'X',  'X',  '6',  'X'),
  ('Sentimental No! No!'                                ,  '3',  '4',  'X',  '4',  '5',  'X',  'X',  'X',  'X'),
  ('Showdown'                                           ,  '9',  '7',  '8',  '8',  '8',  '8',  'X',  'X',  'X'),
  ('The Boy'                                            ,  '3',  '3',  'X',  '4',  '5',  'X',  'X',  '5',  '6'),
  ('Theme of Ez2Dj'                                     ,  '3',  '6',  '7',  '9',  '9',  'X',  'X',  '7',  'X'),
  ('Theme of Ez2Dj'                                     ,  'X', '99',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('We Luv Music'                                       ,  '6',  '5',  '6',  '6',  '9',  '7',  'X',  '7',  '7'),
  ('Where''s my girl ?'                                 ,  '5',  '4',  'X',  '4',  '4',  'X',  'X',  'X',  'X'),
  ('With U Girl'                                        ,  '5',  '3',  '4',  '4',  '6',  'X',  'X',  'X',  'X'),
  ('You are the one for me'                             ,  '3',  '4',  '6',  '6',  '7',  'X',  'X',  '6',  '7'),
  -- ── 3rd TraX ──
  ('2.14'                                               ,  '2',  '2',  '3',  '6',  '6',  'X',  'X',  'X',  'X'),
  ('20000000000'                                        ,  '9',  '9', '12', '11', '12',  '9', '12',  '9',  'X'),
  ('2nd Jewel'                                          ,  '3',  '5',  '7',  '7',  '6', '11',  'X',  'X',  'X'),
  ('Anemia'                                             ,  '2',  '3',  '5',  '6',  '4',  '7',  'X',  'X',  'X'),
  ('Black Market'                                       ,  '5',  '7',  '8',  '8', '10',  '9',  'X',  'X',  '6'),
  ('Cosmic Bird'                                        ,  '6',  '8', '10', '10', '12', '12', '13',  'X', '10'),
  ('Give it 2me'                                        ,  '5',  '5',  '7',  '7',  '7',  'X',  'X',  'X',  '7'),
  ('In a Nutshell'                                      ,  '6',  '4',  'X',  '5',  '6',  'X',  'X',  '7',  'X'),
  ('Lie Lie'                                            ,  '4',  '5',  '8',  '7',  '7', '10',  'X',  'X',  '7'),
  ('Minus 2'                                            ,  '6',  '8',  '9', '10', '11', '11',  'X',  'X', '10'),
  ('M Police'                                           ,  '4',  '7',  '8',  '8',  '7', '10',  'X',  'X',  'X'),
  ('Night Watcher'                                      ,  '4',  '6',  '8',  '9',  '8', '10',  'X',  'X',  'X'),
  ('R.F.C.'                                             ,  '5',  '8', '11', '10',  '9', '11',  'X',  'X', '11'),
  ('Sand Storm'                                         ,  '5',  '8', '10', '10', '11', '11',  'X',  'X',  'X'),
  ('Shake'                                              ,  '3',  '4',  '8',  '9', '10',  'X',  'X',  'X',  'X'),
  ('Smash'                                              ,  '4',  '7',  '8',  '8',  '9', '10',  'X',  'X',  'X'),
  ('Sparrow'                                            ,  '6',  '6',  '8',  '6', '10',  '8', '11',  'X',  'X'),
  ('Substance'                                          ,  '6',  '6',  '8',  '7',  '8',  '9',  'X',  'X',  'X'),
  ('The 3rd Place'                                      ,  '4',  '7',  '9',  '8',  '8',  'X',  'X',  'X',  'X'),
  ('Y Gate'                                             ,  '8',  '8', '11', '12',  '9', '10',  'X',  'X',  'X'),
  -- ── 4th TraX ──
  ('Aquaris'                                            ,  '6',  '7',  '9',  '7',  '9',  '8',  'X',  'X',  '9'),
  ('Blue'                                               ,  '4',  '6',  '8',  '8', '10', '10',  'X',  'X',  'X'),
  ('B.O.W.'                                             ,  '6',  '7',  '9',  '9', '12', '12',  'X',  '8',  'X'),
  ('Calling Me Now'                                     ,  '6',  '6',  'X',  '7',  '7', '10',  'X',  'X',  'X'),
  ('Climax'                                             ,  '7',  '8', '11',  '9', '11',  '8',  'X',  'X',  'X'),
  ('Complex'                                            ,  '5',  '7',  '9', '10', '10', '10', '10',  'X',  'X'),
  ('Delight'                                            ,  '5',  '7',  'X',  '8',  '7', '10',  'X',  '6',  '6'),
  ('Eye of Beholder'                                    ,  '8',  '7', '10',  '8',  '9', '10',  'X',  'X',  'X'),
  ('Feel so sad'                                        ,  '7',  '7',  '9',  '9', '10', '13',  'X',  'X',  'X'),
  ('Fire Storm'                                         , '10', '11', '12', '11', '12', '11', '13', '10',  'X'),
  ('Futurist'                                           ,  '4',  '5',  '8',  '6',  '8',  '9',  'X',  '6',  '8'),
  ('Go !'                                               ,  '3',  '8',  '9',  '7',  '8',  '9',  'X',  '7',  '7'),
  ('J.M.J'                                              ,  '7',  '6',  '8',  '7',  '8', '10',  'X',  'X',  'X'),
  ('Judgment'                                           ,  '3',  '4',  '6',  '6',  '7',  '7',  'X',  'X',  'X'),
  ('Lovely Day'                                         ,  '2',  '4',  '7',  '5',  '6',  '6',  'X',  '6',  '4'),
  ('Mad Robot'                                          ,  '5',  '6',  '9',  '7',  '9', '10',  'X',  'X',  'X'),
  ('Metagalactic'                                       , '10',  '8', '10',  '9', '10', '10',  'X',  'X', '11'),
  ('Ready to Yah'                                       ,  '4',  '4',  '6',  '6',  '6',  '6',  'X',  '6',  'X'),
  ('Shout'                                              ,  '3',  '5',  '8',  '6',  '9',  '8',  'X',  'X',  'X'),
  ('Tokyo 9 p.m.'                                       ,  '3',  '4',  '7',  '5',  '8',  '9',  'X',  'X',  'X'),
  -- ── Platinum ──
  ('느낌'                                                 ,  '3',  '4',  '5',  '4',  '4',  '5',  'X',  'X',  '5'),
  ('Any way you want it'                                ,  '4',  '6',  'X',  '6',  '6',  '8',  'X',  'X',  '5'),
  ('Cellavue'                                           ,  '4',  '3',  'X',  '5',  '5',  '7',  'X',  'X',  'X'),
  ('Memories'                                           ,  '4',  '5',  '7',  '7',  '7',  '9',  'X',  '5',  '6'),
  ('Night Madness'                                      ,  '5',  '7', '11',  '7',  '9', '10',  'X',  '7',  '7'),
  ('Panic Strike'                                       ,  '8', '12', '13', '13', '13', '12',  'X',  'X',  'X'),
  ('Q factor'                                           ,  '8',  '8', '11', '10', '11', '10',  'X',  'X',  'X'),
  ('Riff Guy'                                           ,  '8',  '9', '11', '10',  '8', '12',  'X', '12', '11'),
  ('Spotlight'                                          ,  '3',  '6',  'X',  '8',  '7',  '6',  'X',  'X',  'X'),
  ('Unknown H2'                                         ,  '4',  '6',  '9',  '8',  '8',  '9',  'X',  '4',  'X'),
  ('Weird Wave'                                         ,  '6', '10', '12',  '9', '10', '11', '13',  'X',  'X'),
  ('Zeroize'                                            ,  '9',  '8', '13', '13', '13', '13',  'X', '11', '12'),
  ('Aquaris Physical Inspiration Hyper Blue Mix'        ,  '7',  '7', '10',  '9', '10', '10',  'X',  'X',  'X'),
  ('I''ve Fallen Hot Dog Boogie Groove Mix'             ,  '3',  '4',  '7',  '6',  '6',  '6',  'X',  '6',  'X'),
  ('I''ve got this feeling DJ FE Restless Acid Soul Mix',  '6',  '5',  '8',  '7',  '9',  '8',  'X',  'X',  'X'),
  ('J.M.J DFC Space Gear Re-Formation'                  ,  '4',  '5',  '8',  '7',  '7',  '8',  'X',  'X',  'X'),
  -- ── 6th TraX ──
  ('Bacardi on the Beach'                               ,  '4',  '5',  '6',  '5',  '5',  '6',  'X',  '8',  '7'),
  ('Bacardi on the Beach'                               ,  'X',  '9',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Be-at feedback'                                     ,  '4',  '8',  '9',  '6',  '8',  '7',  'X',  '5',  '6'),
  ('Be Mine'                                            ,  'X',  '8',  '9',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Curse it !!'                                        ,  '3',  '5',  '7',  '5',  '6',  '6',  'X',  '7',  '6'),
  ('Dance Machine'                                      ,  '3',  '7',  '8',  '5',  '7',  '8',  'X',  '9',  '6'),
  ('Dance with me'                                      ,  '4',  '6',  '8',  '6',  '7',  '9',  'X',  '6',  '5'),
  ('Frantic'                                            ,  '4',  '7',  '8',  '8',  '7', '11',  '?',  '8',  '7'),
  ('Frantic'                                            ,  'X', '10',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Move your Body'                                     ,  '4',  '6',  '7',  '6',  '6',  '7',  'X',  '5',  '4'),
  ('1234'                                               ,  '3',  '5',  '8',  '5',  '6',  '6',  'X',  '7',  '5'),
  ('1234'                                               ,  'X',  '9',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Refresh'                                            ,  '4',  '6',  '7',  '4',  '6',  '6',  'X',  '5',  '3'),
  ('Stay with Me'                                       ,  '5',  '6',  '7',  '5',  '7',  '7',  'X',  '5',  '6'),
  ('Ez2Dj (찬가 II)'                                      ,  '3',  '5',  '7',  '5',  '6',  '7',  'X',  '9',  '5'),
  ('Up and Down'                                        ,  '4',  '6',  '7',  '5',  '5',  '6',  'X',  '8',  '4'),
  ('You were the one'                                   ,  '3',  '5',  '8',  '5',  '5',  '5',  'X',  '3',  '4'),
  ('Your Style'                                         ,  '3',  '6',  '7',  '6',  '6',  '7',  'X',  '4',  '5'),
  ('느낌 SONIC A.P.E Ver.'                                ,  '3',  '6',  '7',  '5',  '5',  '6',  'X',  'X',  'X'),
  ('Baby Dance Club Ver.'                               ,  '4',  '6',  '8',  '7',  '8', '10',  'X',  'X',  'X'),
  ('Baby Dance Club Ver.'                               ,  'X', '10',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Be My Baby Funky Mix'                               ,  '3',  '5',  'X',  '5',  '5',  '5',  'X',  'X',  'X'),
  ('Get the Beat Party Mix'                             ,  '2',  '4',  '5',  '3',  '4',  '5',  'X',  'X',  'X'),
  ('I''ve got this feeling Extended Ver.'               ,  '3',  '6',  '7',  '7',  '5',  '7',  'X',  'X',  'X'),
  ('I''ve got this feeling Extended Ver.'               ,  'X',  '9',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Jam A.C. Ver.'                                      ,  '4',  '6',  '7',  '7',  '7',  '8',  'X',  'X',  'X'),
  ('Jam A.C. Ver.'                                      ,  'X',  '9',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('Lie Lie Ceave Beat Ver.'                            ,  '5',  '7',  '8',  '6',  '8',  '8',  'X',  'X',  'X'),
  ('Look Out EK1-Beat Ver.'                             ,  '4',  '7',  '8',  '6',  '7',  '7',  'X',  'X',  'X'),
  ('The Boy EK2-Beat Ver.'                              ,  '4',  '8',  '9',  '6',  '8',  '8',  'X',  'X',  'X'),
  ('The Boy EK2-Beat Ver.'                              ,  'X', '10',  'X',  'X',  'X',  'X',  'X',  'X',  'X'),
  ('With you Girl Beach Ver.'                           ,  '4',  '6',  '7',  '5',  '6',  'X',  'X',  'X',  'X'),
  ('With you Girl Beach Ver.'                           ,  'X',  '8',  'X',  'X',  'X',  'X',  'X',  'X',  'X');

-- ─── 10) 곡 138개 ─────────────────────────────────────────
-- 위 표에서 바로 뽑습니다 (같은 곡이 두 줄인 9곡은 DISTINCT 로 한 행이 됩니다).
INSERT INTO songs (machine_id, title, artist)
SELECT DISTINCT 10, t.title, NULL FROM ez2dj_6th t
ON CONFLICT DO NOTHING;

-- ─── 11) 채보 837개 ───────────────────────────────────────
-- 가로 9칸을 세로로 펼칩니다. `X` 는 채보가 없다는 뜻이라 버리고, `?` 는 난이도만
-- 모르는 것이라 레벨을 NULL 로 남깁니다.
CREATE TEMP TABLE ez2dj_6th_charts AS
SELECT t.title,
       v.mode,
       v.difficulty,
       CASE WHEN v.val = '?' THEN NULL ELSE v.val::int END AS level
FROM ez2dj_6th t
CROSS JOIN LATERAL (VALUES
  ('RUBY',  'NM', t.ruby),
  ('5ST',   'NM', t.s5n),
  ('5ST',   'HD', t.s5h),
  ('7ST',   'NM', t.s7n),
  ('CLUB',  'NM', t.club),
  ('SPACE', 'NM', t.spn),
  ('SPACE', 'HD', t.sph),
  ('CATCH', 'NM', t.cat),
  ('TURN',  'NM', t.turn)
) AS v(mode, difficulty, val)
WHERE v.val NOT IN ('X', '');

-- 컬럼 목록을 DB 상태에 맞춰 짭니다 — 머리말의 `level_label` 항목 참고.
-- 레벨이 NULL 인 셋은 이름이 '?' 입니다 (그 컬럼은 NOT NULL 이라 비울 수 없습니다).
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
    FROM ez2dj_6th_charts e
    JOIN songs s          ON s.machine_id  = 10 AND s.title = e.title
    JOIN game_versions gv ON gv.machine_id = 10 AND gv.code = '6th'
    ON CONFLICT DO NOTHING
  $q$,
    CASE WHEN has_label THEN ', level_label'                      ELSE '' END,
    CASE WHEN has_label THEN ', COALESCE(e.level::text, ''?'')'   ELSE '' END);
END
$mig$;

DROP TABLE ez2dj_6th_charts;
DROP TABLE ez2dj_6th;

-- ─── 12) 집계 캐시 초기화 ─────────────────────────────────
-- 투표가 없으므로 전부 tier_code = 'undecided' 가 됩니다. 이 줄이 없으면 tier_code 가
-- NULL 로 남는데 화면은 NULL 도 '미정' 으로 읽어 결과는 같습니다. 그래도 캐시 컬럼의
-- 뜻을 맞춰 둡니다 (047 과 같은 마무리).
SELECT recalc_chart_stats(c.id)
FROM charts c JOIN songs s ON s.id = c.song_id
WHERE s.machine_id = 10;
