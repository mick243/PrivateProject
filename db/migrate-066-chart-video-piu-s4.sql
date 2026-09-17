-- ============================================================
-- 066 · 펌프 싱글 Lv.4 채보 영상 144건 (charts.video_url)
--
-- ─── 어디서 왔나 ─────────────────────────────────────────
-- 유튜브 채널 '네브시스터NEVSISTER'(@NEVSISTER)의 재생목록
-- 'S1~S5 & D2~D5 Play List'(영상 448개)에서 제목에 S4 가 박힌 영상만 골라
-- 곡 제목으로 맞췄습니다. **직캠이 아니라 게임 화면 캡처**입니다.
--
-- 맞추는 규칙은 기계적이되 느슨하지 않습니다 — 영상 제목에서 앞머리 대괄호와
-- 뒤쪽 레벨 표기(S4 & S7 따위)를 떼고 남은 곡 이름이 songs.title 과 **같을 때만**
-- 넣습니다. '(pre S4 → S5)' 처럼 지금 레벨이 4가 아닌 영상은 걸러냈습니다.
--
-- ─── 161곡 중 144곡 ──────────────────────────────────────
-- 나머지 17곡은 그 채널에 S4 영상이 없습니다(다른 레벨만 있음). 비워 두면
-- 화면이 '채보 영상 찾기' 검색 링크를 대신 보여 줍니다
-- (lib/tier-types.ts chartVideoSearchUrl).
--
-- ─── 곡 제목으로 찾습니다 ─────────────────────────────────
-- charts.id 는 DB 마다 다릅니다. 펌프 안에서 songs.title 은 중복이 없어
-- (확인함) 제목 + 모드 + 레벨이면 채보 하나가 정확히 정해집니다.
-- 이미 값이 있는 줄은 건드리지 않습니다 — 손으로 고른 주소를 덮지 않으려고요.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=' || v.vid
  FROM (VALUES
    ('Accident', 'PuId9YksH2o'),
    ('Allegro Piu Mosso', 'HQjyAi-PGb0'),
    ('Amphitryon', '_jArXlXQmB8'),
    ('Another Truth', 'ZM3_vyJwCAk'),
    ('Arcana Force', 'p4v4_cbWVkc'),
    ('Asterios-ReEntry', 'UJjQiElua9w'),
    ('Athena''s Shield', 'Iynv8TNuCqA'),
    ('Avalanche', 'BFQUOzAwTxc'),
    ('B2', 'ZWwJS2OF-Po'),
    ('BANG BANG', '1WCxrccGtBk'),
    ('Beat of the war 2', 'n-ZmxKCWgdg'),
    ('Beat the ghost', 'qGax1vni_Ns'),
    ('Beethoven Virus', 'Tp3VOfq4Lx0'),
    ('Betrayer Act.2', 'XCGDQVj9H1E'),
    ('Black Dragon', 'Yzf43H0iXkk'),
    ('Blazing', 'ilYOB2EeOJA'),
    ('Break Out', 'xCIZmpqdxqg'),
    ('Bullfighter''s Song', '8L0AqazA1jo'),
    ('Butterfly', 'VDP2_rNIMZM'),
    ('CROSS RAY', '0ZPOOFCWw9I'),
    ('Campanella', '6hmkO7zysbI'),
    ('Caprice of Otada', 'L1hwrmOToBg'),
    ('Chicken Wing', 'tKq_e758PPk'),
    ('Chimera', '579YAiLHu1E'),
    ('Chinese Restaurant', 'awfBMFL6tUI'),
    ('Cleaner', 'i15xBY2erFA'),
    ('Clue', 'kP5xIo40sfM'),
    ('Come To Me', 'fwhUR5y_5qM'),
    ('Cosmical Rhythm', 'Yy6-PzuDOCE'),
    ('Csikos Post', 'Km5UT9SySC0'),
    ('Cygnus', 'CzekZxzA4uA'),
    ('D', 'YfSGuTTEMCA'),
    ('DJ Otada', 'jqqV4XUUOeM'),
    ('Dance with me', '4JbypOHmd6U'),
    ('Destination', 'GHhqGq9hDEA'),
    ('Dignity', 'SijdZCToArE'),
    ('Do you know that - old school', 'lbkNNi6iFZI'),
    ('Earendel', 'GJ0qgMsiQyo'),
    ('Elise', 'XtcWw4Jfyak'),
    ('Elysium', 'ahzd30Yyje8'),
    ('Eternal Universe', 'Jl5fyjK5o5o'),
    ('Extravaganza', 'cD2A3ZKf9CI'),
    ('FLVSH OUT', 'VDbSb9cBSZA'),
    ('Faster Z', 'KJqFh9jcSQY'),
    ('Feel My Happiness', 'PFVC7MPlelY'),
    ('Final Audition 2', 'qR5QpUy8tEQ'),
    ('Final Audition Episode 1', 'YKVUoGKrVTY'),
    ('Final Audition Episode 2-1', 'HmckgcE_mNk'),
    ('Follow Me', 'vnllP2EnlRk'),
    ('Full Moon', 'zX6ikcw08YQ'),
    ('Gargoyle', '9WSTmLLiA3U'),
    ('Get Up (And Go)', 'Y9x4Xh__a0c'),
    ('Get Your Groove On', 'wR6oG8sGIZM'),
    ('God Mode feat. Skizzo', 'DB6hN86sfCM'),
    ('HTTP', 'Ekx5FojB7i8'),
    ('Hardkore of the North', 'JZ43j_xiMAo'),
    ('Harmagedon', 'c-Z_Wpaas44'),
    ('Hello William', 'QjkcwViP59g'),
    ('Hestia', '0XoGoqH4Iy0'),
    ('Highway Chaser', 'sDVD6r4_dgs'),
    ('Hungarian Dance V', 'Uh64bKlLA1E'),
    ('Hyperion', '4gvHXlDucBk'),
    ('I Want U 숏컷', 'U1VjM97F-Tc'),
    ('Idealized Romance', 'OzoyFjaDAik'),
    ('Imprinting', 'TL8UZiuHGv8'),
    ('Jonathan''s Dream', 'GBFcaNDc1os'),
    ('Jump', 'vsvxuxeg-Gc'),
    ('Just hold on(To All Fighters)', 'rRrSaHcaUu4'),
    ('Karyawisata', 'fqh2JZYsMTg'),
    ('Kasou Shinja', '-x4mz2_nOpo'),
    ('King''s Tomb', 'urlPOTi4JqY'),
    ('Life is PIANO', 'kvp1KFitGks'),
    ('Love is a Danger Zone pt.2', 'faYqupcjji8'),
    ('Lucid (PIU Edit)', '6StCTnDnm30'),
    ('Macaron Day', 'r1DqmDt1TQM'),
    ('Matador', 'OnycehfQWrE'),
    ('Monkey Fingers 2', 'vxyfebdVEEU'),
    ('Monkey Fingers', 'jSq03KcSInk'),
    ('Moonlight', 'yGcDA0NvkK4'),
    ('My Dreams', 'e4H8iGNvC5g'),
    ('Necromancy', 'nQ6oy1c_0q8'),
    ('Nemesis', '24qhNZ8L84M'),
    ('Nyan-turne (feat. KuTiNA)', 'Cx5F6-9iw88'),
    ('Obelisque', 'PTFhzp1tcEo'),
    ('Orbit Stabilizer', 'KmOguD9R300'),
    ('Overblow', 'tRlbDp-WrGE'),
    ('Oy Oy Oy', 'YRFC3sFfuUU'),
    ('PRIME', '5Vh8n7dJUF0'),
    ('Papa Gonzales', 'QJh3xYNXSok'),
    ('Passacaglia', 'ZrOFrxcff_Q'),
    ('Perpetual', 'bKN7_cav0LA'),
    ('Pop the track', 'Uz7AXPwTVgU'),
    ('Pumping Jumping', 'f47yxec1zkA'),
    ('Punishment Restaurant', 'rAvX5BuJ78c'),
    ('Queen Of The Red', 'cSqWk4T0V4c'),
    ('Rave ''til the Earth''s End', '7rFHCbp-Kn0'),
    ('Reality', 'P1ycaN8mNZM'),
    ('Red Swan', 'U40FoPbp64w'),
    ('Requiem', 'N7G52xMh-cg'),
    ('SONIC BOOM', 'pHSwwzsVy7Q'),
    ('SUPER☆HARAGURO☆POP', '1DfTW6NwGV4'),
    ('Sarabande', '5EMARgWNRLo'),
    ('Set Me Up', 'A4wQCYu3l0s'),
    ('Silhouette Effect', 'OB2Sa-qZtBs'),
    ('Simon Says, EURODANCE!! (feat. Sara☆M)', 'hsSlUM9OMVQ'),
    ('Smile Diary', 'ww46vwB_W9A'),
    ('Soldiers (TANO*C W TEAM RED ANTHEM)', 'wTv5-658Imw'),
    ('Solitary 2', 'bp6f925p6dU'),
    ('Solitary', 'Sh9TuLilfJY'),
    ('Sorceress Elise', 'tIpkQzRzYok'),
    ('Stardust Overdrive', 'F0Ux2kjE1z8'),
    ('Start On Red', 'OTtJ57ZPmtc'),
    ('Sudden Romance', 'M9zgMuT0RkY'),
    ('Sugar Plum', 'kuM3nYhFxqo'),
    ('Super Capriccio', '6CTOCQUJ7EI'),
    ('Super Fantasy', 'cTjHc8nEvl0'),
    ('Take Out', 'Bi0M6ZyNKNo'),
    ('Tantanmen', 'Survm_M3t64'),
    ('Tepris', '3sZaF3Hgv7U'),
    ('The Apocalypse', 'asdUMR0xM34'),
    ('The Devil', 'S6H0Ll_wW2Q'),
    ('Till the end of time', 'KGoiog_Drtg'),
    ('Timing', 'Afeh6nyBKvI'),
    ('Toccata', 'gHxkud3gWMg'),
    ('Top City', 'gU-OhfMm1uU'),
    ('Tribe Attacker', 'KT4j48snJQI'),
    ('Tropicanic', 'c8-Qnc5v94E'),
    ('Twist of Fate (feat. Ruriling)', '1i-FGZ4Zw6s'),
    ('U Got Me Crazy', 'EGVXR7oQi0Y'),
    ('Ultimate Eyes', 'siYk0VTpWjA'),
    ('Unfelicitas', 'L-FTWcIs4D4'),
    ('Utopia', '2--KEABOjGg'),
    ('Violet Perfume', 'R6He0FtMTkM'),
    ('We Will Meet Again', 'qwg07Kvhatk'),
    ('Wedding Crashers 숏컷', '0LMEZTnDzKM'),
    ('Wedding Crashers', '4xtT8WfVtHs'),
    ('Winter', 'e9tAU1TWE9g'),
    ('Witch Doctor', 'nKkQ16i76qY'),
    ('Xenesis', 'rLIvn6oU_Wc'),
    ('YOU AND I', 'sqyMH4Wk0bE'),
    ('wither garden', 'LwQQ1DbjEyc'),
    ('고민중독 (T.B.H)', '3QdQ7lYuib0'),
    ('천년이 지나서', 'vNfSblnlcxI'),
    ('호랑풍류가', 'hXSehxJZ4Qk')
  ) AS v(title, vid)
  JOIN songs s ON s.title = v.title
  JOIN machines m ON m.id = s.machine_id AND m.name = 'Pump It Up'
 WHERE c.song_id = s.id
   AND c.mode = 'S'
   AND c.level = 4
   AND c.video_url IS NULL;
