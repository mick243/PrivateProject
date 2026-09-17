-- ============================================================
-- 069 · 86 S20 채보 영상 (charts.video_url)
--
-- 066~068 과 같은 출처입니다 — 유튜브 채널 '네브시스터NEVSISTER'.
-- 채널 검색으로 찾았습니다(19·20레벨은 S1~S5 재생목록 밖입니다).
--
-- ─── 왜 PHOENIX 판을 골랐나 ───────────────────────────────
-- 같은 채보의 영상이 둘 있습니다.
--   [PUMP IT UP XX]      8 6 | 86 S20 (GIMMICK LV.10 & GIMMICK EXPERT TITLE)
--   [PUMP IT UP PHOENIX] 8 6 (86) S16 & S20 | S20 GIMMICK LV.7 TITLE  ← 이것
-- 서열표가 PHOENIX 2 를 기준으로 서 있으므로 지금 기계에서 보는 판을 답니다.
-- 이 영상은 S16 과 S20 을 나란히 보여 줍니다 — 오른쪽이 S20.
--
-- 같은 채널의 'EXC 의도를 무시한 5놋 처리' 영상은 고르지 않았습니다 — 그쪽은
-- 공략·성과 기록이고, 이 칸이 필요한 것은 **채보가 어떻게 생겼는가** 입니다.
--
-- ─── '86' 과 '86 풀송' 은 다른 곡 줄입니다 ─────────────────
-- songs 에 둘이 따로 있습니다(86 · 86 풀송). 제목을 정확히 '86' 으로 맞춰
-- 풀송 쪽(S15 · S21)에 붙지 않게 합니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=945Z-sPAzBo'
  FROM songs s
  JOIN machines m ON m.id = s.machine_id
 WHERE s.id = c.song_id
   AND m.name = 'Pump It Up'
   AND s.title = '86'
   AND c.mode = 'S'
   AND c.level = 20
   AND c.video_url IS NULL;
