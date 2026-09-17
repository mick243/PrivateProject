-- ============================================================
-- 067 · 펌프 싱글 Lv.1~3 채보 영상 130건 (charts.video_url)
--
-- 066 과 같은 출처·같은 방법입니다 — 유튜브 채널 '네브시스터NEVSISTER' 의
-- 재생목록 'S1~S5 & D2~D5 Play List'(영상 448개)에서 제목의 레벨 표기를 읽어
-- 그 레벨의 채보에 붙입니다. 직캠이 아니라 게임 화면 캡처입니다.
--
-- 한 영상이 두 줄에 붙는 경우가 있습니다 — 'S1 & S3' 처럼 한 영상에 두 채보가
-- 같이 담긴 것이라, 두 레벨 모두 같은 주소를 가리킵니다.
--
-- '(pre S3 → S4)' 같은 **옛 레벨** 표기는 읽지 않습니다. 괄호 안의 pre · PNX ·
-- Phoenix Modified · Update 주석을 먼저 지우고 남은 S숫자만 봅니다.
--
-- ─── 148곡 중 130곡 ──────────────────────────────────────
-- 나머지 18곡은 그 채널에 해당 레벨 영상이 없습니다. 비워 두면 화면이
-- '채보 영상 찾기' 검색 링크를 대신 보여 줍니다.
--
-- 제목이 로마자로만 올라온 6건(배드 애플·아마이 유우와쿠 등)은 손으로 확인해
-- 넣었습니다 — 기계적 비교로는 한글 제목과 이어지지 않습니다.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다 (lib/db.ts runMigrations 주석 참고).
-- ============================================================

UPDATE charts c
   SET video_url = 'https://www.youtube.com/watch?v=' || v.vid
  FROM (VALUES
    ('%X', 3, 'JmVaL-u5SIg'),
    ('2006. Love Song', 3, 'LOqvAfgOkE8'),
    ('404 (New Era)', 1, 'wNTmvIVbQeE'),
    ('404 (New Era)', 3, 'wNTmvIVbQeE'),
    ('Adrenaline Blaster', 3, 'mq1T1ZTQ4P0'),
    ('All I Want For X-mas', 3, '0-Wqhp9M2jk'),
    ('Anguished Unmaking', 3, 'Ct65pBgVGrI'),
    ('Arch of Darkness', 2, 'cEdQwHKWW40'),
    ('BANG BANG', 2, '1WCxrccGtBk'),
    ('Bad Apple!! feat. nomico', 1, 'bQRMDC2zDpU'),
    ('Bad Apple!! feat. nomico', 3, 'bQRMDC2zDpU'),
    ('Betrayer', 1, 'fpLReU1-jNM'),
    ('Blaze Emotion (Band Version)', 2, 'yx2bX4svSj0'),
    ('Blaze Emotion', 2, 'x1OTFIcEL2c'),
    ('Blaze Emotion', 3, 'x1OTFIcEL2c'),
    ('Bluish Rose', 3, 'FYdHnbMG1pQ'),
    ('Brain Power', 3, 'RZ3AjBuEyrc'),
    ('Cannon X.1', 3, '7J9nIjFnoXk'),
    ('Canon-D', 3, 'KkFSybMKvMM'),
    ('Chase Me', 3, 's-NTr-OIR_8'),
    ('Christmas Memories', 3, 'pXOtJmZmYhk'),
    ('Cross Time', 3, 'syY4_NU93Tk'),
    ('Cycling!', 3, '_h5RHke3D_U'),
    ('Dance with me', 2, '4JbypOHmd6U'),
    ('Death Moon', 3, 'DqIOkM6BWR8'),
    ('Dr. M', 3, 'XhqJntJ1xAc'),
    ('EMOMOMO', 3, 'CcXRgObdVRo'),
    ('Emperor', 2, 'XlyGKy3Rldc'),
    ('Ercitite', 3, 'Kjq7xHTYBd0'),
    ('Festival of Death Moon', 3, 'Remoj2nBCdo'),
    ('Final Audition 3 U.F (Un.Finished)', 2, 'nwsmIjUh5fE'),
    ('Final Audition Ep.2-X', 3, 'weryxV_3S_U'),
    ('Final Audition Episode 2-1', 3, 'yTTytH8NVPk'),
    ('Final Audition', 2, 'GLmHNnEaM0s'),
    ('Forgotten Vampire', 3, 'vRWodEdri2k'),
    ('Full Moon', 2, 'zX6ikcw08YQ'),
    ('Good Night', 3, '4-a_JN2MHdc'),
    ('Guitar Man', 3, 'TAZy9prpLv4'),
    ('HTTP', 2, 'Ekx5FojB7i8'),
    ('HUSH', 3, 'nxHbrOuRfIE'),
    ('Hey U', 3, 'BMGEjn0sbxA'),
    ('Higgledy Piggledy', 2, '6Y5xl27S3h8'),
    ('Houseplan', 3, '8-4ZqAmHYo8'),
    ('I Want U', 3, 'b72b9z3VAqI'),
    ('Ice of Death', 3, 'tSzwGEFitxY'),
    ('Idealized Romance', 2, 'OzoyFjaDAik'),
    ('J-Bong', 3, 'i0D2pT8KwvY'),
    ('K.O.A : Alice In Wonderworld', 1, '829geoZdGlE'),
    ('K.O.A : Alice In Wonderworld', 3, 'n7vcyJs22sM'),
    ('Kitty Cat', 1, 'LlQXxaqG2G4'),
    ('Kitty Cat', 3, 'Lom1NW2w4c8'),
    ('Ladybug', 1, 'JSFSwUJEf6o'),
    ('Ladybug', 3, 'JSFSwUJEf6o'),
    ('Lala', 1, 'NFrCQRv9IkI'),
    ('Lala', 3, 'NFrCQRv9IkI'),
    ('Last Rebirth', 3, 'atzZ1WA5jFU'),
    ('Latino Virus', 3, 'GO5SA1cD8kI'),
    ('Life is PIANO', 2, 'kvp1KFitGks'),
    ('Meteorize', 3, 'KvvqJU63dlE'),
    ('Mitotsudaira', 1, '-49kuhusZtI'),
    ('Moment Day', 3, 'O3Vw_oJ_6eM'),
    ('Monolith', 3, 'OyJFAKwoZ5g'),
    ('Move That Body!', 3, 'rvV1I-ZjouM'),
    ('Mr.Larpus', 3, 'wfL5xqRDkHE'),
    ('Native', 3, 'Ta9J7jtxu5o'),
    ('Night Duty', 3, 'L1_NC7e2UhY'),
    ('Nostalgia', 3, 'xT6mA8YKAzI'),
    ('Obelisque', 2, 'PTFhzp1tcEo'),
    ('Pavane', 3, 'hLFgzSIkWTA'),
    ('Phantom -Intermezzo-', 3, 'yRvUXMSy1Zg'),
    ('Phantom', 2, '1f4i2P7DyxY'),
    ('Point Break', 3, 'YUK8cFeLpew'),
    ('Pop the track', 2, '4--1XszTLAo'),
    ('Poseidon', 3, 'vKVYar5Onwk'),
    ('Pull Me Up (Feat. Monya)', 3, 'gSBx0G5e_BI'),
    ('Pump Me Amadeus', 3, 'PO943sNz-1o'),
    ('Pumptris 8Bit ver.', 3, '92s4BMaUaBo'),
    ('Pumptris Quattro', 3, 'jkC_hvyLIQo'),
    ('Reminiscence', 3, 'Eqpo3rZpSr8'),
    ('Removable Disk0', 3, '5-SIytHF2eo'),
    ('Rolling Christmas', 3, '2go3f6gFq5U'),
    ('Scorpion King', 3, 'f3nvpttkgWU'),
    ('Selfishness', 3, 'YKtPLomVoeA'),
    ('Set Me Up', 2, 'A4wQCYu3l0s'),
    ('Slapstick Parfait', 3, 'F6XgxWVR0Cw'),
    ('Smells Like a Chocolate', 3, '9BFsXKRfP18'),
    ('Solitary', 2, 'tH9U-BS_qK0'),
    ('Star Command', 3, 'VyMkyoMsrCo'),
    ('Stardream (feat. Romelon)', 1, 'dIxoP21sKJk'),
    ('Stardream (feat. Romelon)', 3, 'dIxoP21sKJk'),
    ('Sugar Conspiracy Theory', 1, 'qoN1CFF6XDc'),
    ('Sugar Conspiracy Theory', 3, '1VQer1KUT7Q'),
    ('Sweet Wonderland', 3, 'wIjuV-ZGIGc'),
    ('Switronic 숏컷', 3, 'mfm_UUj3_5Y'),
    ('Switronic', 3, 'FZc4jwxvU2w'),
    ('Tek -Club Copenhagen-', 3, 'kZ22JPgGllo'),
    ('Tepris', 2, '3sZaF3Hgv7U'),
    ('The End of the World ft. Skizzo', 3, 'zza0Qwydiic'),
    ('The People Didn''t Know', 3, 'M0-GNrCNqbs'),
    ('The Reverie', 3, 'EwoTkbQX4I4'),
    ('Till the end of time', 3, '_-G2n866SgE'),
    ('Transacaglia in G-minor', 3, 'AtUAw7XIE4k'),
    ('Travel to Future', 3, 'SmRhY82LGy4'),
    ('Tropicanic', 2, 'c8-Qnc5v94E'),
    ('Turkey March -Minimal Tunes-', 3, 'q2v3oO7Z9P4'),
    ('Turkey March', 3, 'i60Ne1-blzM'),
    ('U Got 2 Know', 2, '03-ZBr6WZZY'),
    ('U Got Me Rocking', 3, 'z295J2i1hw8'),
    ('Ugly Dee', 3, 'NidUI-1xZ-I'),
    ('Unique', 3, 'dz8lyv39DdQ'),
    ('Up & Up', 3, 'cYEJbfvB8F4'),
    ('Vook', 3, 'JiVWv5d_Fmk'),
    ('We Got 2 Know', 1, 'FJ2MyL2EKf8'),
    ('What Happened', 3, 'BQPFne7-lYM'),
    ('Will o'' The Wisp', 2, 'dNjh6G0RAxw'),
    ('X-Rave', 3, '31DpWp3fMzI'),
    ('Xtree', 2, 'dA695Tm-8WM'),
    ('Xuxa', 3, 'S_XrEmkmE34'),
    ('Yeo Rae A', 1, 'jq6HbnYJMz4'),
    ('Yeo Rae A', 3, 'i5Q0khDdfJE'),
    ('Yoropiku Pikuyoro!', 3, 'FDki7yI918s'),
    ('You again my love', 1, 'Pql7BXh4TiI'),
    ('You again my love', 3, 'Pql7BXh4TiI'),
    ('고민중독 (T.B.H)', 2, '3QdQ7lYuib0'),
    ('날아올라', 3, 'V_wImEn-DKc'),
    ('빌려온 고양이 (Do the Dance)', 1, 'zi4NnBM_6Bk'),
    ('빌려온 고양이 (Do the Dance)', 3, 'zi4NnBM_6Bk'),
    ('아마이 유우와쿠 데인져러스', 1, 'ylU1c4PyYCc'),
    ('아마이 유우와쿠 데인져러스', 3, 'ylU1c4PyYCc'),
    ('조깅', 3, 'emSUC8had2E')
  ) AS v(title, lv, vid)
  JOIN songs s ON s.title = v.title
  JOIN machines m ON m.id = s.machine_id AND m.name = 'Pump It Up'
 WHERE c.song_id = s.id
   AND c.mode = 'S'
   AND c.level = v.lv
   AND c.video_url IS NULL;
