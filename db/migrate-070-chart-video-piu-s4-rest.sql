-- ============================================================
-- 070 · 펌프 싱글 Lv.4 남은 곡 채보 영상 (charts.video_url)
--
-- 066 에서 채우지 못한 17곡을 채널 검색으로 하나씩 다시 찾았습니다.
-- 그중 6곡을 찾았고, 11곡은 그 채널에 S4 영상이 **없습니다**(다른 레벨만 있음).
--
-- ─── 제목이 달라 못 찾던 것들 ─────────────────────────────
-- 066 은 재생목록 제목과 songs.title 을 글자로 맞춥니다. 아래 셋은 채널이
-- **영어 제목**으로 올려 두어 그 방식으로는 이어지지 않았습니다.
--   일 더하기 일은 귀요미 = Cutie Song
--   무혼                  = Solitary
--   무혼 2                = Solitary 2
--
-- ⚠ 무혼 · 무혼 2 는 songs 에 **Solitary · Solitary 2 와 따로** 들어 있습니다
--   (같은 곡이 한글·영어 두 줄). 그래서 같은 영상이 두 줄에 붙습니다. 곡 줄을
--   합치는 것은 이 마이그레이션의 일이 아닙니다 — 오락실 중복 12쌍을 합쳤던 것과
--   같은 종류의 정리가 따로 필요합니다.
--
-- ─── Storm 은 S2 도 같이 ──────────────────────────────────
-- 영상 제목이 'S2 & S4' 라 두 채보가 한 영상에 담겨 있습니다. 067 이 S2 를
-- 비워 둔 것은 그 재생목록에 이 영상이 없었기 때문이고, 규칙은 067 과 같습니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=' || v.vid
  FROM (VALUES
    ('GOODBOUNCE',            4, 'YpjyK65K2Mo'),
    ('My Way',                4, 'A-ua4qFcTYQ'),
    ('Storm',                 4, 'tZ8VG0EgYtQ'),
    ('Storm',                 2, 'tZ8VG0EgYtQ'),
    ('일 더하기 일은 귀요미', 4, '2koFnYawvcI'),
    ('무혼',                  4, 'Sh9TuLilfJY'),
    ('무혼 2',                4, 'bp6f925p6dU')
  ) AS v(title, lv, vid)
  JOIN songs s ON s.title = v.title
  JOIN machines m ON m.id = s.machine_id AND m.name = 'Pump It Up'
 WHERE c.song_id = s.id
   AND c.mode = 'S'
   AND c.level = v.lv
   AND c.video_url IS NULL;
