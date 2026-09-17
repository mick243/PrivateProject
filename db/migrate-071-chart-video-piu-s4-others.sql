-- ============================================================
-- 071 · 펌프 싱글 Lv.4 채보 영상 5건 — 채널 검색 밖에서 찾은 것
--
-- 070 에서 "그 채널에 S4 영상이 없다" 고 적은 11곡을, 이번에는 채널 안이 아니라
-- **유튜브 전체 검색**으로 다시 찾았습니다. 그중 5곡이 나왔습니다.
--
-- ─── 없던 게 아니라 채널 검색이 못 찾던 것이었습니다 ──────
-- 다섯 개 모두 결국 같은 채널(네브시스터NEVSISTER)의 영상입니다. 채널 안 검색은
-- 질의당 결과를 두어 개로 끊어 주는 반면, 전체 검색은 같은 영상을 찾아냅니다.
-- 채널 검색 결과가 비었다고 그 채널에 없다고 단정하면 안 됩니다.
--
-- ─── 직캠은 제외했습니다 ──────────────────────────────────
-- 제목에 직캠 · fancam · 따라하기 · 발판 · 손캠 이 들어간 것은 거릅니다.
-- 남은 것은 게임 화면 캡처입니다(같은 채널의 다른 영상에서 눈으로 확인한 형식).
--
-- ─── 레벨 짝이 우리 표와 맞습니다 ─────────────────────────
-- 영상 제목의 레벨 짝이 charts 의 레벨과 정확히 겹칩니다 — 우연이 아닙니다.
--   Etude Op 10-4        S4 & S7   ← 표: S4 S7 S11 S17 S23
--   Euphorianic 숏컷     S4 & S7   ← 표: S4 S7 S10 S17
--   Galaxy Collapse      S4 & S7   ← 표: S4 S7 S11 S15 S19 S23
--   Love is A Danger Zone S4 & S8  ← 표: S4 S8 S11 S17 S20
--   Mitotsudaira         S4 & S9   ← 표: S4 S9 S15 S19
-- 'Love is a Danger Zone pt. 2' 는 **다른 곡**이고 이미 제 영상이 있습니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=' || v.vid
  FROM (VALUES
    ('Etude Op 10-4',         'b1ECazsIEsM'),
    ('Euphorianic 숏컷',      '0Ns7DesE8oE'),
    ('Galaxy Collapse',       'DFWWNe4ufZY'),
    ('Love is A Danger Zone', 'vpOJxco5aBw'),
    ('Mitotsudaira',          'drbcgTxkEGk')
  ) AS v(title, vid)
  JOIN songs s ON s.title = v.title
  JOIN machines m ON m.id = s.machine_id AND m.name = 'Pump It Up'
 WHERE c.song_id = s.id
   AND c.mode = 'S'
   AND c.level = 4
   AND c.video_url IS NULL;
