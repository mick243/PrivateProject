-- ============================================================
-- 072 · 펌프 싱글 Lv.4 남은 5곡 채보 영상 — 사람이 고른 것
--
-- 066 · 070 · 071 이 끝내 못 채운 5곡을, 프로젝트 주인이 직접 주소를 골라
-- 넣었습니다. 기계로 찾지 못한 이유가 있습니다 — 아래를 지우지 마세요.
--
-- ─── 제목은 S3 인데 S4 에 답니다 ──────────────────────────
-- 다섯 영상 모두 제목이 **S3**(또는 Single 3) 입니다. 오타가 아닙니다.
-- 이 채보들은 레벨이 3에서 4로 올라갔고, 영상은 올라가기 전에 찍힌 것입니다.
-- 배치는 같으므로 지금 S4 를 고른 사람이 보기에 맞는 영상입니다.
--
--   Cannon X.1                   [StepF2] Cannon X.1 S3
--   Ice of Death                 [PUMP IT UP XX] Ice of Death(아이스 오브 데스) S3
--   Reminiscence                 (S3 영상 — 067 이 Reminiscence S3 에 단 것과 같은 것)
--   Tek -Club Copenhagen-        (S3 영상 — 067 이 S3 에 단 것과 같은 것)
--   Turkey March -Minimal Tunes- Pump It Up Fiesta - ... - Single 3 - FPC
--
-- 그래서 제목의 레벨만 보고 맞추는 066·067 의 방식으로는 절대 찾지 못합니다.
-- 자동으로 다시 채우려 들지 마세요 — 사람이 판단한 값입니다.
--
-- ⚠ Reminiscence 와 Tek 은 **S3 줄과 S4 줄이 같은 영상**을 가리키게 됩니다.
--   charts 에 같은 채보가 두 레벨로 남아 있다는 뜻입니다(레벨 승격 때 옛 줄이
--   지워지지 않음). 영상이 아니라 데이터를 정리해야 할 문제입니다 — 오락실
--   중복 12쌍을 합쳤던 것과 같은 계열.
--
-- ─── 출처가 아케이드가 아닌 것 둘 ─────────────────────────
-- Cannon X.1(StepF2)과 Turkey March(Fiesta PC)는 PC 시뮬레이터 화면입니다.
-- 직캠이 아니라 채보 화면이므로 이 칸의 쓸모에는 맞습니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=' || v.vid
  FROM (VALUES
    ('Cannon X.1',                   '3SlPnZMf4FQ'),
    ('Ice of Death',                 'BopwX6Qxo9s'),
    ('Reminiscence',                 'Eqpo3rZpSr8'),
    ('Tek -Club Copenhagen-',        'kZ22JPgGllo'),
    ('Turkey March -Minimal Tunes-', '1u5YO2uMb14')
  ) AS v(title, vid)
  JOIN songs s ON s.title = v.title
  JOIN machines m ON m.id = s.machine_id AND m.name = 'Pump It Up'
 WHERE c.song_id = s.id
   AND c.mode = 'S'
   AND c.level = 4
   AND c.video_url IS NULL;
