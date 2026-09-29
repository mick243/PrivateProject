-- 원본: db/migrate-022-drop-novasonic-novarash-remix.sql
-- 이 파일은 scripts/prisma-migrations-build.mjs 가 생성합니다. 손으로 고치지 마세요 —
-- 내용을 바꾸면 체크섬이 달라져 이미 적용된 DB 에서 migrate deploy 가 거부합니다.

-- ============================================================
-- 022 · Novasonic Remix · Novarash Remix 제거
--
-- ─── 왜 ──────────────────────────────────────────────────
-- 021 이 넣은 99곡 중 이 둘은 삭제곡 문서와 겹치지만 비고가 '부활' 이라
-- 남겨 둔 곡입니다. 요청에 따라 다시 뺍니다.
--
--   Novasonic Remix (노바소닉 리믹스)
--   Novarash Remix  (노바래쉬 리믹스)
--
-- 같은 이유로 남았던 `Ugly Duck Toccata`(미운 오리 토카타)는 그대로 둡니다.
--
-- ─── 딸린 데이터 ─────────────────────────────────────────
-- 두 곡 모두 채보가 0개라 CASCADE 로 지워질 것이 없습니다
-- (서열표·투표·채보 평가 영향 없음). 곡 행만 사라집니다.
--
-- ─── 여러 번 실행해도 결과가 같습니다 ────────────────────
-- 지울 것이 없으면 0행입니다.
--
-- 되돌리려면:
--   INSERT INTO songs (machine_id, title, artist)
--   VALUES (1, 'Novasonic Remix', NULL), (1, 'Novarash Remix', NULL)
--   ON CONFLICT (machine_id, title) DO NOTHING;
-- ============================================================

DELETE FROM songs
WHERE machine_id = 1
  AND title IN ('Novasonic Remix', 'Novarash Remix');
