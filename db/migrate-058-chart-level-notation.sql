-- ============================================================
-- 채보 난이도를 **게임이 쓰는 표기 그대로** 받는다.
--
-- 지금까지는 펌프(1~26)와 사볼(1~20)만 있어서 `level INTEGER CHECK (1..30)` 로
-- 충분했습니다. 다른 기종을 들이면 이 전제가 세 방향으로 깨집니다.
--
--   · pop'n music 은 1~50 이라 **상한에 걸려 INSERT 가 실패**합니다.
--   · jubeat(10.0~10.9) · GITADORA(1.00~9.99) 는 소수입니다. 반올림하면
--     10.3 과 10.7 이 같은 칸에 들어가 서열표가 뜻을 잃습니다.
--   · maimai · 츄니즘 · 노스탤지어는 `13+` 처럼 **숫자가 아닌 표기**를 씁니다.
--     그리고 13 과 13+ 는 플레이어에게 서로 다른 층입니다.
--
-- ── 왜 컬럼을 둘로 나누나 ──
-- 한 컬럼으로는 '정렬'과 '이름'을 동시에 못 합니다. 숫자만 두면 `13+` 를 적을
-- 곳이 없고, 문자열만 두면 '9' 가 '10' 보다 뒤로 갑니다.
--
--   level        = 줄 세우는 값        (13+ → 13.5)
--   level_label  = 게임이 부르는 이름  (13+ → '13+')
--
-- 서열표가 묶는 단위는 **label** 입니다 — 화면에 보이는 층과 같아야 하니까요.
-- level 은 그 층들을 순서대로 세우는 데만 씁니다.
--
-- 13+ 를 13.5 로 적는 것은 그 게임이 13.5 라고 주장하는 게 아니라, 13 과 14
-- 사이에 세우기 위한 정렬 키입니다. 실제 내부 상수(13.7 같은)를 아는 게임은
-- 그 값을 그대로 넣어도 label 만 '13+' 면 화면은 그대로입니다.
-- ============================================================

-- ── level: 정수 → 소수 ──────────────────────────────────────
-- CHECK 를 먼저 떼지 않으면 타입 변경이 막힙니다.
ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_level_check;
ALTER TABLE charts ALTER COLUMN level TYPE NUMERIC(4,2);
-- 상한 99 는 pop'n(50) 위로 충분히 띄운 값입니다. 1 미만은 어느 게임에도 없습니다.
ALTER TABLE charts ADD CONSTRAINT charts_level_check CHECK (level >= 1 AND level <= 99);

-- ── level_label ────────────────────────────────────────────
ALTER TABLE charts ADD COLUMN IF NOT EXISTS level_label TEXT;

-- 이미 들어와 있는 펌프·사볼은 전부 정수라 숫자를 그대로 이름으로 쓴다.
-- trim_scale 이 8.00 → 8 로 꼬리 0 을 떼어 준다 ('8.00' 이 아니라 '8' 이어야 한다).
UPDATE charts SET level_label = trim_scale(level)::text WHERE level_label IS NULL;

ALTER TABLE charts ALTER COLUMN level_label SET NOT NULL;

-- ── 같은 곡·같은 모드에서 같은 **이름**의 채보는 하나 ──────────
-- 기준이 level 에서 label 로 옮겨갑니다. 13 과 13+ 는 label 이 달라 둘 다 남고,
-- 정렬 키가 같아도(13.5 로 겹칠 일은 없지만) 이름이 다르면 다른 채보입니다.
--
-- NULLS NOT DISTINCT — mode 가 NULL 인 채보(난이도 미표기, migrate-047)끼리도
-- 중복을 막아야 해서 기존 제약과 같은 규칙을 유지합니다.
ALTER TABLE charts DROP CONSTRAINT IF EXISTS charts_song_id_mode_level_key;
ALTER TABLE charts
  ADD CONSTRAINT charts_song_id_mode_level_label_key
  UNIQUE NULLS NOT DISTINCT (song_id, mode, level_label);

-- 서열표 조회는 (모드, 층)으로 들어오므로 인덱스도 label 기준으로 옮긴다.
DROP INDEX IF EXISTS charts_lookup_idx;
CREATE INDEX charts_lookup_idx ON charts (mode, level_label);
-- 층 목록을 순서대로 뽑을 때 쓴다 (listLevels 의 ORDER BY).
CREATE INDEX IF NOT EXISTS charts_level_order_idx ON charts (level, level_label);
