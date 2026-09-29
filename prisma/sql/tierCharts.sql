-- 서열표 보드·채보 상세의 채보 줄 (lib/tier.ts getTierBoard · getChartDetail).
--
-- 왜 TypedSQL 인가: 정렬 규칙이 6단계이고(표시값 반올림 → 배치 순서 → 제목 → 난이도
-- 순서표 → 난이도 코드 → 모드) 하나하나에 이유가 있습니다 — lib/tier.ts 의 주석이 그
-- 근거입니다. JS 로 옮겨 적으면 같은 규칙이 두 곳이 되고, 레벨 필터의 모양은
-- charts_lookup_idx 를 타기 위한 것이라 그대로 둡니다.
--
-- 파라미터
--   $1 playerId?     내 클리어·투표·특수패턴 표시를 붙일 사람. NULL 이면 전부 false/NULL
--   $2 chartId?      한 채보만 (상세). NULL 이면 보드
--   $3 machineId?    게임 (보드)
--   $4 mode?         모드 (보드). NULL = 모드로 좁히지 않음 (난이도 축 게임)
--   $5 level?        레벨 (보드). 미상 레벨 보드는 $6 으로
--   $6 levelUnknown  true 면 level IS NULL 인 채보만 (미상 보드)
--   $7 versionId?    버전 (보드). NULL = 버전으로 좁히지 않음
--
-- @param {Int} $1:playerId?
-- @param {Int} $2:chartId?
-- @param {Int} $3:machineId?
-- @param {String} $4:mode?
-- @param {Float} $5:level?
-- @param {Boolean} $6:levelUnknown
-- @param {Int} $7:versionId?
SELECT c.id, s.title, s.artist, s.machine_id, c.mode, c.difficulty, c.level,
       c.vote_count, c.avg_vote, c.convergence, c.tier_code, c.special_count,
       c.video_url,
       (cr.player_id IS NOT NULL) AS my_clear,
       dv.value AS my_vote,
       (sm.player_id IS NOT NULL) AS my_special
FROM charts c
JOIN songs s ON s.id = c.song_id
-- 난이도는 쉬운 순으로 세워야 한다 (코드 알파벳순이면 4D 가 EZ 보다 앞).
LEFT JOIN machine_difficulties md ON md.machine_id = s.machine_id AND md.code = c.difficulty
LEFT JOIN clear_records    cr ON cr.chart_id = c.id AND cr.player_id = $1::int
LEFT JOIN difficulty_votes dv ON dv.chart_id = c.id AND dv.player_id = $1::int
LEFT JOIN special_marks    sm ON sm.chart_id = c.id AND sm.player_id = $1::int
WHERE ($2::int IS NULL OR c.id = $2::int)
  AND ($3::int IS NULL OR s.machine_id = $3::int)
  AND ($4::text IS NULL OR c.mode = $4::text)
  -- 레벨이 NULL 인 채보(난이도 미상)도 자기 보드를 가져야 한다. 'c.level = NULL' 은
  -- 아무것도 고르지 못하므로 NULL 쪽 가지($6)를 따로 둔다 (lib/tier.ts 주석).
  AND ($5::numeric IS NULL OR c.level = $5::numeric)
  AND (NOT $6::boolean OR c.level IS NULL)
  AND ($7::int IS NULL OR c.version_id = $7::int)
-- 화면에 보이는 값(소수점 2자리)으로 줄을 세운다. 동점이면 먼저 배치된 곡(c.id)이 왼쪽,
-- 투표가 없는 채보는 제목순. 제목까지 같으면 난이도 순서표 → 난이도 코드 → 모드.
ORDER BY ROUND(c.avg_vote, 2) DESC NULLS LAST,
         CASE WHEN c.avg_vote IS NULL THEN NULL ELSE c.id END ASC NULLS LAST,
         s.title ASC,
         md.sort_order ASC NULLS LAST,
         c.difficulty ASC NULLS LAST,
         c.mode ASC NULLS LAST;
