-- ============================================================
-- 068 · Nakakapagpabagabag S19 채보 영상 (charts.video_url)
--
-- 066 · 067 과 같은 출처입니다 — 유튜브 채널 '네브시스터NEVSISTER'.
-- 다만 이 곡은 S1~S5 재생목록 밖(19레벨)이라 채널 검색으로 찾았습니다.
--
-- ─── 왜 PHOENIX 판을 골랐나 ───────────────────────────────
-- 같은 채보의 영상이 둘 있습니다.
--   [PUMP IT UP XX]      … S19 (pre S18 → S19)
--   [PUMP IT UP PHOENIX] … S19 | GIMMICK LV.6 TITLE   ← 이것
-- 서열표가 PHOENIX 2 를 기준으로 서 있으므로(화면 안내문) 지금 기계에서 보는
-- 것과 같은 판을 답니다. XX 판은 기믹 연출과 배치가 다릅니다.
--
-- 같은 사람이 올린 'NS(Non Step) 올퍼펙' 영상도 있지만 고르지 않았습니다 —
-- 그쪽은 성과 기록이고, 이 칸이 필요한 것은 **채보가 어떻게 생겼는가** 입니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=riSgyL1JZq0'
  FROM songs s
  JOIN machines m ON m.id = s.machine_id
 WHERE s.id = c.song_id
   AND m.name = 'Pump It Up'
   AND s.title = 'Nakakapagpabagabag'
   AND c.mode = 'S'
   AND c.level = 19
   AND c.video_url IS NULL;
