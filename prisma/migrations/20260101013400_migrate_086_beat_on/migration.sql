-- 원본: db/migrate-086-beat-on.sql
-- 이 파일은 scripts/prisma-migrations-build.mjs 가 생성합니다. 손으로 고치지 마세요 —
-- 내용을 바꾸면 체크섬이 달라져 이미 적용된 DB 에서 migrate deploy 가 거부합니다.

-- ============================================================
-- 086 · 기종 추가 — 비트온 (BEAT ON)
--
-- 비트온은 펌프 잇 업 곡을 손으로 치는 안다미로의 별도 기체입니다("손펌프"). 나무위키
-- 「오락실/지역」 문서도 펌프와 따로 적는데, 목록에 없어서 수입 도구가 버리거나
-- (lib/namu-machines · scripts/import-namu-machines.ts) 펌프와 섞일 위험이 있었습니다.
-- 펌프와 다른 기종으로 따로 둡니다 (2026-11-24 사용자 결정).
--
-- sort_order 는 펌프(10) 바로 뒤 — 칩 · 목록에서 펌프 옆에 보이게.
--
-- ⚠ 여러 번 실행해도 결과가 같아야 합니다. 기종 표에만 한 줄 넣습니다.
-- ============================================================

INSERT INTO machines (name, short_name, category, sort_order) VALUES
  ('BEAT ON (비트온)', '비트온', 'rhythm', 11)
ON CONFLICT (name) DO NOTHING;

-- 수동 INSERT 이후 시퀀스 정렬 (migrate-038 과 같은 이유)
SELECT setval('machines_id_seq', (SELECT MAX(id) FROM machines));
