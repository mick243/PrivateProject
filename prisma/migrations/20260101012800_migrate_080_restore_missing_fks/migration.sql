-- 원본: db/migrate-080-restore-missing-fks.sql
-- 이 파일은 scripts/prisma-migrations-build.mjs 가 생성합니다. 손으로 고치지 마세요 —
-- 내용을 바꾸면 체크섬이 달라져 이미 적용된 DB 에서 migrate deploy 가 거부합니다.

-- ============================================================
-- 개발 DB 에서 사라진 외래키 12개를 되돌립니다.
--
-- [무슨 일이 있었나]
--   스키마 파일(schema.sql · schema-tier.sql · schema-community.sql · schema-board.sql ·
--   migrate-017)에는 이 12개가 `REFERENCES … ON DELETE …` 로 처음부터 적혀 있습니다.
--   그런데 **개발 DB 에만 없습니다.** 2026-09-22 에 "마이그레이션이 만든 빈 DB" 와
--   개발 DB 를 pg_constraint 로 대조해 확인했습니다 (docs/PRISMA-MIGRATION.md §7).
--
--   원인으로 보이는 것: `.pglite` → PostgreSQL 이관(scripts/migrate-pglite-to-pg.mjs)이
--   복사 중 `session_replication_role = replica` 로 FK 트리거를 꺼 둔 채 행을 넣습니다.
--   그 과정에서 제약이 살아남지 못한 것으로 보입니다.
--
-- [왜 고치나]
--   지금은 앱이 무결성을 코드로도 지켜서 조용합니다. 다만 개발 DB 에서는 없는 오락실을
--   즐겨찾기에 담는 요청이 404 가 아니라 **성공합니다** — FK 가 없어 23503 이 나지
--   않기 때문입니다(lib/pg-errors.ts → lib/api-errors.ts 경로가 통째로 죽습니다).
--   즉 **개발에서 재현되지 않는 운영 버그**가 생기는 자리입니다.
--
-- [어떻게]
--   - 그 컬럼에 이미 FK 가 있으면 건너뜁니다. 새로 만든 DB 는 스키마 파일이 이미 걸어
--     두었으므로 이 파일은 아무 일도 하지 않고 이력만 남깁니다.
--   - `NOT VALID` 로 먼저 걸고 그다음 `VALIDATE` 합니다. NOT VALID 도 **새로 들어오는
--     행은 곧바로 막습니다** — 기존 행을 훑지 않을 뿐입니다. 큰 테이블에서 잠금을 오래
--     쥐지 않으려는 순서입니다.
--   - 검증이 실패하면(부모가 없는 고아 행이 있으면) 경고만 남기고 넘어갑니다. 제약은
--     NOT VALID 상태로 남아 새 쓰기는 막습니다. 마이그레이션을 통째로 실패시켜 배포를
--     세우는 것보다, 새 쓰기를 즉시 막고 사람이 고아 행을 치우는 쪽이 낫습니다.
--     (2026-09-22 개발 DB 실측 고아 행: 12개 전부 0건)
--
--   되돌리려면: ALTER TABLE <표> DROP CONSTRAINT <표>_<컬럼>_fkey;
-- ============================================================

DO $$
DECLARE
  spec   RECORD;
  fk     TEXT;
  added  INT := 0;
  kept   INT := 0;
BEGIN
  FOR spec IN
    -- 정의는 스키마 파일에 적힌 것과 한 글자도 다르지 않아야 합니다 (ON DELETE 포함).
    SELECT * FROM (VALUES
      ('arcade_favorites',  'arcade_id',  'arcades',         'CASCADE'),
      ('arcade_favorites',  'player_id',  'players',         'CASCADE'),
      ('arcade_reviews',    'arcade_id',  'arcades',         'CASCADE'),
      ('machine_modes',     'machine_id', 'machines',        'CASCADE'),
      ('machine_reports',   'arcade_id',  'arcades',         'CASCADE'),
      ('machine_reports',   'machine_id', 'machines',        'CASCADE'),
      ('machine_reports',   'cabinet_id', 'arcade_cabinets', 'SET NULL'),
      ('player_identities', 'player_id',  'players',         'CASCADE'),
      ('posts',             'machine_id', 'machines',        'CASCADE'),
      ('songs',             'machine_id', 'machines',        'CASCADE'),
      ('tier_grades',       'machine_id', 'machines',        'CASCADE'),
      ('tier_settings',     'machine_id', 'machines',        'CASCADE')
    ) AS t(child, col, parent, on_delete)
  LOOP
    fk := spec.child || '_' || spec.col || '_fkey';

    -- 그 컬럼을 가리키는 FK 가 이미 있으면(이름이 다르더라도) 손대지 않습니다.
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.conrelid = format('public.%I', spec.child)::regclass
        AND a.attname = spec.col
    ) THEN
      kept := kept + 1;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE %s NOT VALID',
      spec.child, fk, spec.col, spec.parent, spec.on_delete
    );
    added := added + 1;

    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', spec.child, fk);
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING
        '% 를 걸었으나 검증하지 못했습니다 — %.% 에 부모가 없는 행이 있습니다. '
        '새 쓰기는 이미 막혔습니다. 고아 행을 치운 뒤 ALTER TABLE %I VALIDATE CONSTRAINT %I 를 돌리세요.',
        fk, spec.child, spec.col, spec.child, fk;
    END;
  END LOOP;

  RAISE NOTICE '외래키 복구 — 새로 건 것 %개 · 이미 있어 건너뛴 것 %개', added, kept;
END $$;
